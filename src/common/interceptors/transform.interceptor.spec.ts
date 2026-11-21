import { of } from "rxjs";
import { TransformInterceptor } from "./transform.interceptor";

describe("TransformInterceptor", () => {
  it("把数据包成 { code: 0, message: 'success', data }", (done) => {
    const interceptor = new TransformInterceptor();
    const result$ = interceptor.intercept(
      {} as never,
      {
        handle: () => of("payload"),
      } as never,
    );
    result$.subscribe((res) => {
      expect(res).toEqual({ code: 0, message: "success", data: "payload" });
      done();
    });
  });
});
