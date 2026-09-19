import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { DeviceStatusService } from './device-status.service';
import { MqttService } from '@/common/mqtt/mqtt.service';
import { RedisService } from '@/common/redis/redis.service';
import { MessageType } from './types/mqtt-message.type';

describe('DeviceStatusService', () => {
  let service: DeviceStatusService;
  let mqttService: any;
  let redisService: any;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        DeviceStatusService,
        {
          provide: MqttService,
          useValue: {
            subscribe: jest.fn(),
            onMessage: jest.fn(),
          },
        },
        {
          provide: RedisService,
          useValue: {
            getValue: jest.fn(),
            setValue: jest.fn(),
          },
        },
        {
          provide: ConfigService,
          useValue: {
            get: jest.fn((key: string) => {
              if (key === 'MQTT_STATUS_TOPIC') return 'zhianxin/event/report';
              if (key === 'MQTT_STATUS_TTL_SECONDS') return 300;
              return undefined;
            }),
          },
        },
      ],
    }).compile();

    service = module.get<DeviceStatusService>(DeviceStatusService);
    mqttService = module.get(MqttService);
    redisService = module.get(RedisService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  describe('onModuleInit', () => {
    it('should subscribe to zhianxin/event/report', () => {
      service.onModuleInit();

      expect(mqttService.subscribe).toHaveBeenCalledWith('zhianxin/event/report');
      expect(mqttService.onMessage).toHaveBeenCalledWith(expect.any(Function));
    });
  });

  describe('handleMessage', () => {
    it('should parse full DEVICE_STATUS and cache it', async () => {
      const payload = Buffer.from(
        JSON.stringify({
          version: '1.0',
          messageId: 'msg-001',
          messageType: MessageType.DEVICE_STATUS,
          deviceId: 'S10002-003971',
          occurredAt: 1784298000000,
          sentAt: 1784298000123,
          seq: 1024,
          data: {
            online: {
              status: 'ONLINE',
              connectedAt: 1784297900000,
              lastSeenAt: 1784298000000,
              disconnectReason: null,
            },
            battery: {
              percent: 51,
              chargingStatus: 'CHARGING',
              lowBattery: 0,
              reportedAt: 1784298000000,
            },
            version: {
              firmwareVersion: '2.0.949',
              hardwareVersion: '1.1',
              protocolVersion: '1.0',
            },
            runtime: {
              powerState: 'ON',
              workState: 'IDLE',
              sleepState: 'AWAKE',
              bootAt: 1784211600000,
              uptimeSeconds: 86400,
              lastInteractionAt: 1784297900000,
            },
            network: {
              wifiConnected: 1,
              ssid: 'xxxx-wifi',
              rssi: -58,
              lastConnectedAt: 1784297900000,
              lastDisconnectReason: null,
            },
          },
        }),
      );

      service.handleMessage('zhianxin/event/report', payload);
      await new Promise((resolve) => setImmediate(resolve));

      expect(redisService.setValue).toHaveBeenCalledWith(
        'device:status:S10002-003971',
        expect.any(String),
        300,
      );

      const cached = JSON.parse(redisService.setValue.mock.calls[0][1]);
      expect(cached.deviceId).toBe('S10002-003971');
      expect(cached.online.status).toBe('ONLINE');
      expect(cached.battery.percent).toBe(51);
      expect(cached.network.wifiConnected).toBe(1);
      expect(cached.updatedAt).toBe(1784298000000);
    });

    it('should merge partial status modules', async () => {
      redisService.getValue.mockResolvedValue(
        JSON.stringify({
          deviceId: 'S10002-003971',
          online: { status: 'ONLINE', lastSeenAt: 1784297900000 },
          battery: { percent: 30, chargingStatus: 'NOT_CHARGING', lowBattery: 0, reportedAt: 1784297900000 },
          updatedAt: 1784297900000,
        }),
      );

      const payload = Buffer.from(
        JSON.stringify({
          version: '1.0',
          messageId: 'msg-002',
          messageType: MessageType.DEVICE_STATUS,
          deviceId: 'S10002-003971',
          occurredAt: 1784298000000,
          sentAt: 1784298000123,
          seq: 1025,
          data: {
            battery: {
              percent: 51,
              chargingStatus: 'CHARGING',
              lowBattery: 0,
              reportedAt: 1784298000000,
            },
          },
        }),
      );

      service.handleMessage('zhianxin/event/report', payload);
      await new Promise((resolve) => setImmediate(resolve));

      const cached = JSON.parse(redisService.setValue.mock.calls[0][1]);
      expect(cached.online.status).toBe('ONLINE');
      expect(cached.battery.percent).toBe(51);
      expect(cached.battery.chargingStatus).toBe('CHARGING');
    });

    it('should ignore duplicate messageId', async () => {
      const payload = Buffer.from(
        JSON.stringify({
          version: '1.0',
          messageId: 'msg-003',
          messageType: MessageType.DEVICE_STATUS,
          deviceId: 'S10002-003971',
          occurredAt: 1784298000000,
          sentAt: 1784298000123,
          seq: 1026,
          data: { battery: { percent: 80, chargingStatus: 'NOT_CHARGING', lowBattery: 0, reportedAt: 1784298000000 } },
        }),
      );

      service.handleMessage('zhianxin/event/report', payload);
      service.handleMessage('zhianxin/event/report', payload);
      await new Promise((resolve) => setImmediate(resolve));

      expect(redisService.setValue).toHaveBeenCalledTimes(1);
    });

    it('should ignore messages on other topics', async () => {
      service.handleMessage('other/topic', Buffer.from('{}'));
      await new Promise((resolve) => setImmediate(resolve));

      expect(redisService.setValue).not.toHaveBeenCalled();
    });

    it('should ignore invalid JSON payload', async () => {
      const loggerWarnSpy = jest.spyOn((service as any).logger, 'warn').mockImplementation();
      service.handleMessage('zhianxin/event/report', Buffer.from('not-json'));
      await new Promise((resolve) => setImmediate(resolve));

      expect(redisService.setValue).not.toHaveBeenCalled();
      expect(loggerWarnSpy).toHaveBeenCalled();
    });

    it('should handle CONVERSATION_RECORD without caching status', async () => {
      const payload = Buffer.from(
        JSON.stringify({
          version: '1.0',
          messageId: 'msg-004',
          messageType: MessageType.CONVERSATION_RECORD,
          deviceId: 'S10002-003971',
          occurredAt: 1784297810000,
          sentAt: 1784297813600,
          seq: 1025,
          data: {
            sessionId: 'session-20260717-001',
            userText: '你今天做什么了？',
            toyReply: '我一直在等你聊天呀。',
            language: 'zh-CN',
          },
        }),
      );

      service.handleMessage('zhianxin/event/report', payload);
      await new Promise((resolve) => setImmediate(resolve));

      expect(redisService.setValue).not.toHaveBeenCalled();
    });
  });

  describe('getStatus', () => {
    it('should return cached status when available', async () => {
      const cached = {
        deviceId: 'S10002-003971',
        online: { status: 'ONLINE', lastSeenAt: 1784298000000 },
        battery: { percent: 51, chargingStatus: 'CHARGING', lowBattery: 0, reportedAt: 1784298000000 },
        updatedAt: 1784298000000,
      };
      redisService.getValue.mockResolvedValue(JSON.stringify(cached));

      const result = await service.getStatus('S10002-003971');

      expect(redisService.getValue).toHaveBeenCalledWith('device:status:S10002-003971');
      expect(result.online.status).toBe('ONLINE');
      expect(result.battery.percent).toBe(51);
    });

    it('should return empty status when cache miss', async () => {
      redisService.getValue.mockResolvedValue(null);

      const result = await service.getStatus('S10002-003971');

      expect(result.deviceId).toBe('S10002-003971');
      expect(result.online).toBeNull();
      expect(result.battery).toBeNull();
      expect(result.version).toBeNull();
      expect(result.runtime).toBeNull();
      expect(result.network).toBeNull();
    });
  });

  describe('cacheStatus', () => {
    it('should write status to redis with ttl', async () => {
      const status = {
        deviceId: 'S10002-003971',
        online: { status: 'ONLINE' as const, lastSeenAt: 1784298000000 },
        updatedAt: 1784298000000,
      };

      await service.cacheStatus('S10002-003971', status as any);

      expect(redisService.setValue).toHaveBeenCalledWith(
        'device:status:S10002-003971',
        JSON.stringify(status),
        300,
      );
    });
  });
});
