// scripts/reliability/kimi-web-identity-probe.mjs
//
// kimi-web 运行服务身份探针（前置盘点「有凭据环境代跑」格的正规工具，
// 2026-10-02 双席会审修正后落地——内联模板的截断非脱敏 / 父进程 env 污染 /
// fetch 非 2xx 不 reject 等边界全部由本脚本承担）。
//
// 边界（镜像 src/backends/kimiWeb.js 的生产纪律）：
//   - 凭据只从 env 读（缺省变量名 KIMI_WEB_TOKEN，--token-env 可覆盖），非空
//     检查；值绝不进 argv / 输出 / 错误文本。
//   - 请求禁跟随重定向（redirect:"manual"）+ 10s 超时；Authorization 头只在
//     进程内存构造。
//   - 输出只有受约束的身份字段（类型 + 长度检查的字符串），绝不输出原始正文
//     或异常 message（错误只出分类名 + HTTP 状态码）。
//   - 「携带凭据」≠「端点已认证」：200 也可能是无鉴权端点——输出字段
//     authObserved 单独承载请求是否带凭据的事实，认证语义由读结果的人判。
//   - 文档版本字段 ≠ 运行程序版本：serverVersion 标注 upstreamSelfReported。
//
// 用法：node scripts/wao-node.cjs scripts/reliability/kimi-web-identity-probe.mjs --url http://127.0.0.1:<port> [--token-env KIMI_WEB_TOKEN]
// 退出码：0=探针已运行（结果即记录，HTTP/网络错误也是合法结果）；1=用法错误/凭据缺失。
// 授权主体：操作员或获该次取证授权的代跑者（"有凭据环境"不是授权主体）。

const DEFAULT_TIMEOUT_MS = 10_000;
const MAX_FIELD_LEN = 120;

function boundedString(value) {
  if (typeof value !== "string" || value.length === 0) return null;
  return value.length > MAX_FIELD_LEN ? value.slice(0, MAX_FIELD_LEN) : value;
}

function usage(stream) {
  stream.write(
    "Usage: node scripts/wao-node.cjs scripts/reliability/kimi-web-identity-probe.mjs "
    + "--url <base-url> [--token-env <VAR_NAME>]\n"
    + "  --url        kimi web 服务基地址（如 http://127.0.0.1:58627），探 /openapi.json\n"
    + "  --token-env  凭据环境变量名（缺省 KIMI_WEB_TOKEN；只读 env，值不进输出）\n",
  );
}

export function parseArgs(argv) {
  const out = { url: null, tokenEnv: "KIMI_WEB_TOKEN" };
  const valueOf = (flag, index) => {
    const value = argv[index + 1];
    if (typeof value !== "string" || value.startsWith("--")) {
      throw new Error(`${flag} requires a value`);
    }
    return value;
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") return { ...out, help: true };
    if (arg === "--url") { out.url = valueOf(arg, i); i += 1; continue; }
    if (arg === "--token-env") { out.tokenEnv = valueOf(arg, i); i += 1; continue; }
    throw new Error(`unknown flag: ${arg}`);
  }
  return out;
}

export async function probeIdentity({ url, tokenEnv, env = process.env, fetchFn = fetch, timeoutMs = DEFAULT_TIMEOUT_MS }) {
  // 仅 loopback：明文 HTTP + Bearer 头发给非回环地址会把凭据送上网络——
  // serveUrl 指向非回环时拒绝执行（fix-closed，不降级重试）。
  let host = null;
  try { host = new URL(url).hostname; } catch { host = null; }
  const loopback = host === "127.0.0.1" || host === "localhost" || host === "::1" || host === "[::1]";
  if (!loopback) {
    return { exitCode: 1, stderr: `refusing non-loopback target: ${url} (plaintext HTTP + bearer to a non-loopback host would put the credential on the network)` };
  }
  const token = env[tokenEnv];
  if (typeof token !== "string" || token.length === 0) {
    return { exitCode: 1, stderr: `credential missing: env ${tokenEnv} not set (operator or authorized deputy must run this in a credentialed environment)` };
  }
  const base = { outcome: null, target: `${url.replace(/\/+$/, "")}/openapi.json`, authObserved: true };
  let response;
  try {
    response = await fetchFn(base.target, {
      headers: { Authorization: `Bearer ${token}` },
      redirect: "manual",
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    return { exitCode: 0, stdout: { ...base, outcome: "network-error", errorKind: typeof error?.name === "string" ? error.name : "unknown" } };
  }
  if (response.status !== 200) {
    return { exitCode: 0, stdout: { ...base, outcome: "http-error", status: response.status } };
  }
  let parsed = null;
  try {
    parsed = await response.json();
  } catch {
    return { exitCode: 0, stdout: { ...base, outcome: "unparseable-body", status: response.status } };
  }
  const spec = parsed && typeof parsed === "object" ? parsed : {};
  return {
    exitCode: 0,
    stdout: {
      ...base,
      outcome: "responded",
      status: response.status,
      openapiSpec: boundedString(spec.openapi),
      docTitle: boundedString(spec.info?.title),
      docVersion: boundedString(spec.info?.version),
      // kimi 上游自报的服务版本字段（非 OpenAPI 规范字段）——字段语义未经独立
      // 证实为运行程序版本，消费侧按“上游自报”读。
      serverVersion: boundedString(spec.version),
      serverVersionSemantics: "upstream-self-reported",
      pathCount: spec.paths && typeof spec.paths === "object" ? Object.keys(spec.paths).length : null,
    },
  };
}

export async function main(argv, { stdout = process.stdout, stderr = process.stderr, env = process.env, fetchFn = fetch } = {}) {
  let args;
  try {
    args = parseArgs(argv);
  } catch (error) {
    stderr.write(`${error.message}\n`);
    usage(stderr);
    return 1;
  }
  if (args.help) { usage(stdout); return 0; }
  if (typeof args.url !== "string" || args.url.length === 0 || !/^https?:\/\//.test(args.url)) {
    stderr.write("--url is required (http(s) base url)\n");
    usage(stderr);
    return 1;
  }
  const result = await probeIdentity({ url: args.url, tokenEnv: args.tokenEnv, env, fetchFn });
  if (result.stderr) { stderr.write(`${result.stderr}\n`); return result.exitCode; }
  stdout.write(`${JSON.stringify(result.stdout)}\n`);
  return result.exitCode;
}

if (process.argv[1] && process.argv[1].endsWith("kimi-web-identity-probe.mjs")) {
  const code = await main(process.argv.slice(2));
  process.exit(code);
}
