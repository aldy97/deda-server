import { IsNotEmpty, IsString, Matches } from "class-validator";

/**
 * 设备上线登记（机芯厂《设备端接口文档》3.1 节）。
 * 字段名与协议保持一致；全局 ValidationPipe 开启 forbidNonWhitelisted，
 * 仅声明协议字段，固件多带字段将被 400 拒绝。
 */
export class LoginMacDto {
  /** 设备 MAC：允许带 `:`/`-` 分隔符与大小写，服务端统一归一化 */
  @IsString()
  @IsNotEmpty()
  mac: string;

  /** md5_ascii(md5_utf8(macKey + normalizedMac)) 的 32 位小写十六进制 */
  @IsString()
  @Matches(/^[0-9a-f]{32}$/, {
    message: "password must be a 32-char lowercase hex md5",
  })
  password: string;
}
