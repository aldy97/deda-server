import { Injectable, ForbiddenException } from '@nestjs/common';
import { PrismaService } from '@/common/prisma/prisma.service';
import { UpsertChildProfileDto } from './dto/upsert-child-profile.dto';

@Injectable()
export class ChildProfilesService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * 查询指定设备的 owner info
   * @returns ChildProfile 或 null（未填写）
   */
  async getByDevice(userId: string, deviceId: string) {
    const binding = await this.ensureDeviceOwnership(userId, deviceId);

    return this.prisma.childProfile.findUnique({
      where: { deviceId: binding.device.id },
    });
  }

  /**
   * 创建或更新指定设备的 owner info
   * 仅允许 name 和 birthday
   */
  async upsertByDevice(
    userId: string,
    deviceId: string,
    dto: UpsertChildProfileDto,
  ) {
    const binding = await this.ensureDeviceOwnership(userId, deviceId);

    return this.prisma.childProfile.upsert({
      where: { deviceId: binding.device.id },
      update: {
        name: dto.name,
        birthday: dto.birthday,
        englishName: dto.englishName,
      },
      create: {
        userId,
        deviceId: binding.device.id,
        name: dto.name,
        birthday: dto.birthday,
        englishName: dto.englishName,
      },
    });
  }

  /**
   * 校验当前用户是否拥有该设备
   */
  private async ensureDeviceOwnership(userId: string, deviceId: string) {
    const binding = await this.prisma.userDeviceBinding.findFirst({
      where: {
        userId,
        device: { deviceId },
      },
      include: { device: true },
    });

    if (!binding) {
      throw new ForbiddenException('Device not bound to current user');
    }

    return binding;
  }
}
