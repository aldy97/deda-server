import { Test, TestingModule } from '@nestjs/testing';
import { VendorGateway } from './vendor.gateway';
import { VendorService } from './vendor.service';
import { VendorTextInDto } from './dto/vendor-text-in.dto';

describe('VendorGateway', () => {
  let gateway: VendorGateway;
  let vendorService: jest.Mocked<VendorService>;

  const mockEmit = jest.fn();
  const mockTo = jest.fn().mockReturnValue({ emit: mockEmit });
  const mockServer = {
    emit: mockEmit,
    to: mockTo,
  } as any;

  const createMockClient = (id = 'socket-001') =>
    ({
      id,
      emit: jest.fn(),
      join: jest.fn(),
      leave: jest.fn(),
      disconnect: jest.fn(),
      handshake: { query: {} },
    }) as any;

  beforeEach(async () => {
    mockEmit.mockClear();
    mockTo.mockClear();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        VendorGateway,
        {
          provide: VendorService,
          useValue: {
            handleTextIn: jest.fn(),
            handleStatusReport: jest.fn(),
            handleBindCallback: jest.fn(),
            handleConversationBackup: jest.fn(),
            getHealth: jest.fn(),
          },
        },
      ],
    }).compile();

    gateway = module.get<VendorGateway>(VendorGateway);
    vendorService = module.get(VendorService);

    gateway.server = mockServer;
  });

  it('should be defined', () => {
    expect(gateway).toBeDefined();
  });

  describe('handleConnection', () => {
    it('should accept a vendor client connection', () => {
      const client = createMockClient('socket-001');
      gateway.handleConnection(client);
      expect(gateway['deviceSocketMap'].has('socket-001')).toBe(false);
    });
  });

  describe('handleDisconnect', () => {
    it('should clean up device mapping on disconnect', () => {
      const client = createMockClient('socket-002');
      gateway['deviceSocketMap'].set('dev-002', 'socket-002');

      gateway.handleDisconnect(client);

      expect(gateway['deviceSocketMap'].has('dev-002')).toBe(false);
    });
  });

  describe('handlePing', () => {
    it('should reply vendor:pong with timestamp', () => {
      const client = createMockClient();
      const before = Date.now();

      gateway.handlePing(client);

      const after = Date.now();
      expect(client.emit).toHaveBeenCalledTimes(1);
      expect(client.emit).toHaveBeenCalledWith(
        'vendor:pong',
        expect.objectContaining({
          timestamp: expect.any(Number),
        }),
      );

      const [, payload] = client.emit.mock.calls[0];
      expect(payload.timestamp).toBeGreaterThanOrEqual(before);
      expect(payload.timestamp).toBeLessThanOrEqual(after);
    });
  });

  describe('handleTextIn', () => {
    it('should process text and emit vendor:text:out to the same client', async () => {
      const client = createMockClient('socket-003');
      const dto: VendorTextInDto = {
        deviceId: 'dev-003',
        asrText: '你好',
      };
      const reply = {
        deviceId: 'dev-003',
        responseText: '收到：你好',
        context: {},
        ttsOptions: {},
      };

      vendorService.handleTextIn.mockResolvedValue(reply);

      const result = await gateway.handleTextIn(client, dto);

      expect(vendorService.handleTextIn).toHaveBeenCalledWith(dto);
      expect(client.emit).toHaveBeenCalledWith('vendor:text:out', reply);
      expect(result).toEqual(reply);
      expect(gateway['deviceSocketMap'].get('dev-003')).toBe('socket-003');
    });

    it('should emit vendor:error when service throws', async () => {
      const client = createMockClient('socket-004');
      const dto: VendorTextInDto = {
        deviceId: 'dev-004',
        asrText: '你好',
      };

      vendorService.handleTextIn.mockRejectedValue(new Error('LLM timeout'));

      const result = await gateway.handleTextIn(client, dto);

      expect(client.emit).toHaveBeenCalledWith(
        'vendor:error',
        expect.objectContaining({
          event: 'vendor:text:in',
          message: 'LLM timeout',
        }),
      );
      expect(result).toBeNull();
    });

    it('should emit vendor:error for invalid payload', async () => {
      const client = createMockClient('socket-005');
      const invalidPayload = { deviceId: '', asrText: '' } as VendorTextInDto;

      const result = await gateway.handleTextIn(client, invalidPayload);

      expect(client.emit).toHaveBeenCalledWith(
        'vendor:error',
        expect.objectContaining({
          event: 'vendor:text:in',
          message: expect.stringContaining('deviceId'),
        }),
      );
      expect(vendorService.handleTextIn).not.toHaveBeenCalled();
      expect(result).toBeNull();
    });
  });
});
