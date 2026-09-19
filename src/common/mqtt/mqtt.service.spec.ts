import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { MqttService } from './mqtt.service';
import * as mqtt from 'mqtt';

jest.mock('mqtt');

describe('MqttService', () => {
  let service: MqttService;
  let config: ConfigService;
  let mockClient: any;

  beforeEach(async () => {
    jest.clearAllMocks();
    mockClient = {
      on: jest.fn(),
      end: jest.fn(),
      subscribe: jest.fn(),
      publish: jest.fn(),
    };

    (mqtt.connect as jest.Mock).mockReturnValue(mockClient);

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        MqttService,
        {
          provide: ConfigService,
          useValue: {
            get: jest.fn(),
          },
        },
      ],
    }).compile();

    service = module.get<MqttService>(MqttService);
    config = module.get<ConfigService>(ConfigService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  describe('connect', () => {
    it('should create mqtt client and register event handlers', () => {
      service.connect('mqtt://localhost:1883');

      expect(mqtt.connect).toHaveBeenCalledWith('mqtt://localhost:1883', {
        reconnectPeriod: 5000,
        connectTimeout: 30000,
        clean: true,
      });
      expect(mockClient.on).toHaveBeenCalledWith('connect', expect.any(Function));
      expect(mockClient.on).toHaveBeenCalledWith('message', expect.any(Function));
      expect(mockClient.on).toHaveBeenCalledWith('error', expect.any(Function));
      expect(mockClient.on).toHaveBeenCalledWith('close', expect.any(Function));
      expect(mockClient.on).toHaveBeenCalledWith('reconnect', expect.any(Function));
    });
  });

  describe('subscribe', () => {
    it('should subscribe to topic with QoS 1 when connected', () => {
      service.connect('mqtt://localhost:1883');
      service.subscribe('zhianxin/event/report');

      expect(mockClient.subscribe).toHaveBeenCalledWith(
        'zhianxin/event/report',
        { qos: 1 },
        expect.any(Function),
      );
    });

    it('should warn when client is not connected', () => {
      const loggerWarnSpy = jest.spyOn((service as any).logger, 'warn').mockImplementation();
      service.subscribe('device/+/status');

      expect(mockClient.subscribe).not.toHaveBeenCalled();
      expect(loggerWarnSpy).toHaveBeenCalled();
    });
  });

  describe('publish', () => {
    it('should publish message with QoS 1 and retain false when connected', () => {
      service.connect('mqtt://localhost:1883');
      service.publish('zhianxin/event/report', JSON.stringify({ online: true }));

      expect(mockClient.publish).toHaveBeenCalledWith(
        'zhianxin/event/report',
        JSON.stringify({ online: true }),
        { qos: 1, retain: false },
        expect.any(Function),
      );
    });

    it('should warn when client is not connected', () => {
      const loggerWarnSpy = jest.spyOn((service as any).logger, 'warn').mockImplementation();
      service.publish('device/dev-001/status', 'payload');

      expect(mockClient.publish).not.toHaveBeenCalled();
      expect(loggerWarnSpy).toHaveBeenCalled();
    });
  });

  describe('onMessage', () => {
    it('should register message handler and invoke it on message', () => {
      const handler = jest.fn();
      service.onMessage(handler);

      service.connect('mqtt://localhost:1883');
      const messageHandler = mockClient.on.mock.calls.find((call: any[]) => call[0] === 'message')[1];
      const payload = Buffer.from('test');
      messageHandler('device/dev-001/status', payload);

      expect(handler).toHaveBeenCalledWith('device/dev-001/status', payload);
    });
  });

  describe('disconnect', () => {
    it('should end client when connected', () => {
      service.connect('mqtt://localhost:1883');
      service.disconnect();

      expect(mockClient.end).toHaveBeenCalled();
      expect(service.getClient()).toBeUndefined();
    });
  });

  describe('onModuleInit', () => {
    it('should connect when MQTT_URL is configured', () => {
      (config.get as jest.Mock).mockReturnValue('mqtt://localhost:1883');
      service.onModuleInit();

      expect(mqtt.connect).toHaveBeenCalledWith('mqtt://localhost:1883', {
        reconnectPeriod: 5000,
        connectTimeout: 30000,
        clean: true,
      });
    });

    it('should warn when MQTT_URL is not configured', () => {
      (config.get as jest.Mock).mockReturnValue(undefined);
      const loggerWarnSpy = jest.spyOn((service as any).logger, 'warn').mockImplementation();
      service.onModuleInit();

      expect(mqtt.connect).not.toHaveBeenCalled();
      expect(loggerWarnSpy).toHaveBeenCalled();
    });
  });
});
