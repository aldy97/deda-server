import { Controller, Get, Query, Req, UseGuards } from "@nestjs/common";
import {
  ApiBearerAuth,
  ApiOperation,
  ApiQuery,
  ApiTags,
} from "@nestjs/swagger";
import { IsNotEmpty, IsString } from "class-validator";
import { AnalyticsAuthService } from "./analytics-auth.service";
import { AnalyticsAuthGuard } from "./guards/analytics-auth.guard";

class AnalyticsLoginQueryDto {
  @IsString()
  @IsNotEmpty()
  username!: string;

  @IsString()
  @IsNotEmpty()
  password!: string;
}

@ApiTags("analytics-auth")
@Controller("analytics/auth")
export class AnalyticsAuthController {
  constructor(private readonly authService: AnalyticsAuthService) {}

  /**
   * 管理员登录。按 dashboard 全局约定使用 GET；
   * 凭据在 query 中，部署侧需确保 access log 不记录 query string。
   */
  @Get("login")
  @ApiOperation({ summary: "Dashboard 管理员登录（GET 约定）" })
  @ApiQuery({ name: "username", required: true })
  @ApiQuery({ name: "password", required: true })
  login(@Query() query: AnalyticsLoginQueryDto) {
    return this.authService.login(query.username, query.password);
  }

  @Get("profile")
  @UseGuards(AnalyticsAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: "当前管理员信息" })
  profile(@Req() req: { user: { username: string; displayName: string } }) {
    return {
      username: req.user.username,
      displayName: req.user.displayName,
    };
  }
}
