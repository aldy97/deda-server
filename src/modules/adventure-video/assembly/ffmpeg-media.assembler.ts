import { spawn } from "child_process";
import { mkdtemp, readFile, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import type { VideoStudioConfig } from "@/config/video.config";
import type {
  AssembleInput,
  AssembleResult,
  MediaAssembler,
  ProbeResult,
} from "../ports/media.ports";
import {
  buildAssSubtitles,
  buildAudioMixArgs,
  buildConcatArgs,
  buildFinalArgs,
  buildNormalizeArgs,
  buildSrt,
  parseProbeOutput,
  resolutionToSize,
} from "../worker/ffmpeg.args";

export class FfmpegError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "FfmpegError";
  }
}

interface CommandResult {
  stdout: string;
  stderr: string;
}

function runCommand(
  command: string,
  args: string[],
  timeoutMs = 600_000,
): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new FfmpegError("TIMEOUT", `${command} 超时（${timeoutMs}ms）`));
    }, timeoutMs);
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.on("error", (error: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      reject(
        new FfmpegError(
          error.code === "ENOENT" ? "BINARY_NOT_FOUND" : "SPAWN_FAILED",
          `${command} 启动失败：${error.message}`,
        ),
      );
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) {
        resolve({ stdout, stderr });
        return;
      }
      reject(
        new FfmpegError(
          "COMMAND_FAILED",
          `${command} 退出码 ${code}：${stderr.slice(-800)}`,
        ),
      );
    });
  });
}

/**
 * ffmpeg 合成实现。
 *
 * 只在 worker 镜像里跑；API 镜像不装 ffmpeg，因此本类不会被 API 进程实例化。
 * 所有中间文件都在 mkdtemp 目录里，finally 清理——失败也不留垃圾。
 */
@Injectable()
export class FfmpegMediaAssembler implements MediaAssembler {
  constructor(private readonly configService: ConfigService) {}

  async probe(buffer: Buffer): Promise<ProbeResult> {
    const dir = await mkdtemp(join(tmpdir(), "adv-video-probe-"));
    try {
      const file = join(dir, "input.bin");
      await writeFile(file, buffer);
      return await this.probeFile(file);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }

  async assemble(input: AssembleInput): Promise<AssembleResult> {
    const dir = await mkdtemp(join(tmpdir(), "adv-video-assemble-"));
    const { width, height } = resolutionToSize(input.resolution);
    const totalDurationSec =
      input.totalDurationSec ||
      input.clips.reduce((sum, clip) => sum + clip.durationSec, 0);

    try {
      const normalized: string[] = [];
      for (const [index, clip] of input.clips.entries()) {
        const source = join(dir, `clip-${index}.mp4`);
        const target = join(dir, `norm-${index}.mp4`);
        await writeFile(source, clip.buffer);
        await runCommand(
          "ffmpeg",
          buildNormalizeArgs({ input: source, output: target, width, height }),
        );
        normalized.push(target);
      }

      const listFile = join(dir, "concat.txt");
      await writeFile(
        listFile,
        normalized
          .map((path) => `file '${path.replace(/'/g, "'\\''")}'`)
          .join("\n"),
      );
      const videoFile = join(dir, "video.mp4");
      await runCommand("ffmpeg", buildConcatArgs(listFile, videoFile));

      const beatFiles: Array<{ path: string; delayMs: number }> = [];
      for (const [index, beat] of input.beats.entries()) {
        const path = join(dir, `beat-${index}.wav`);
        await writeFile(path, beat.buffer);
        beatFiles.push({ path, delayMs: Math.round(beat.startSec * 1000) });
      }
      const audioFile = join(dir, "audio.wav");
      await runCommand(
        "ffmpeg",
        buildAudioMixArgs(beatFiles, totalDurationSec, audioFile),
      );

      const assFile = join(dir, "subtitles.ass");
      await writeFile(
        assFile,
        buildAssSubtitles(input.cues, { width, height }),
      );

      const finalFile = join(dir, "final.mp4");
      await runCommand(
        "ffmpeg",
        buildFinalArgs({
          video: videoFile,
          audio: audioFile,
          assFile,
          output: finalFile,
          fontsDir: this.fontsDir(),
        }),
      );

      const buffer = await readFile(finalFile);
      const probed = await this.probeFile(finalFile);
      return {
        buffer,
        durationSec: probed.durationSec || totalDurationSec,
        srt: buildSrt(input.cues),
      };
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }

  private async probeFile(file: string): Promise<ProbeResult> {
    const { stdout } = await runCommand("ffprobe", [
      "-v",
      "error",
      "-print_format",
      "json",
      "-show_format",
      "-show_streams",
      file,
    ]);
    return parseProbeOutput(JSON.parse(stdout));
  }

  private fontsDir(): string {
    const config = this.configService.get<VideoStudioConfig>("video");
    return config?.fontsDir ?? "/usr/share/fonts";
  }
}
