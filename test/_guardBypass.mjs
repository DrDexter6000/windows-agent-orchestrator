// test/_guardBypass.mjs
//
// TD-40：全局测试初始化器。设置 WAO_SKIP_VERSION_GUARD=1，让测试套件在任意 Node 版本上跑——
// 测试 mock 真实 spawn，不依赖 v22 的内置 Job Object 进程隔离（那是生产硬约束，不是测试前提）。
// 被测代码（cli/daemon/backgroundRunner）的版本守卫在生产环境（未设此 env）仍强制生效。
//
// 用法：node --test --import ./test/_guardBypass.mjs（已接入 npm test 脚本）。

process.env.WAO_SKIP_VERSION_GUARD = "1";
