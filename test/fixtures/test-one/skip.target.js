// test:one shim 靶件（非套件成员）：全 skip——零通过静默绿防护的触发形态。
import { test } from "node:test";
test("target: always skipped", { skip: true }, () => {});
