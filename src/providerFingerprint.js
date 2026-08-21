// src/providerFingerprint.js
//
// R23-C（lane 认证身份维度补全，ADR-0026 v2 方向，2026-08-21）：认证身份第 4 维
// providerKey 的归一化函数——唯一实现宿主。scripts 侧下向 import 本模块
// （先例：scripts/reliability/certification.mjs ← ../../src/application/
// certificationReasons.js），不允许第二套归一化实现。
//
// 指纹元组 = 规范化 baseUrl + apiKeyEnv 变量名。比的是环境变量的【名字】，
// 绝不是密钥值——密钥值永不进入指纹、summary 或任何磁盘记录。
//
// 归一化规范（契约测试钉死：test/run-lifecycle/certGateIdentityFreshness.test.js）：
//   - scheme + host 小写（WHATWG URL 对 special scheme 已归一；此处显式兜底，
//     不依赖运行时实现细节）
//   - 剥默认端口（https 的 :443 / http 的 :80）；非默认端口保留
//   - path 保留大小写，仅去一个尾斜杠（根 "/" 归一为空）
//   - baseUrl 与 apiKeyEnv 均先 trim 再判空/派生（" K " 与 "K" 是同一变量名，
//     不得产出不同指纹）
//   - 显式丢弃 userinfo / query / fragment——防凭据随指纹落入磁盘 summary
//
// 输出 `<canonical-baseUrl>|<apiKeyEnv>`。"|" 不允许出现在任一分量中
// （URL path 带 "|" 的配置属病态形状）——保证编码单射、无拼接歧义。
//
// 返回 null 的情形 = 「不可派生」：无 provider 块 / baseUrl 或 apiKeyEnv 缺失
// 或空白 / 非 http(s) URL / 解析失败 / 分量含 "|"。
//
// ⚠ null 碰撞的诚实口径（fail-open 方向，勿误读为 fail-closed）：非 http(s)
// 协议或分量含 "|" 的【已配置】provider 块同样返回 null——与「已观察、确认
// 无接入方」的 null 是同一个值。消费侧（认证门 matchedCertRecord / 续跑
// runContinue 漂移比对）把这种病态块当作无接入方处理：与记录侧 null 匹配、
// 该维度放行，而不是拒绝派发。即病态形状走 fail-open（比对被跳过），只有
// 双侧都成功派生出指纹时才真正逐字节把关。
//
// 消费侧三态纪律（见 runManager.matchedCertRecord）：null = 已观察、确认无接入方；
// undefined 只保留给 legacy 旧记录（该字段从未落账）。本函数永不返回 undefined。

const KEY_SEPARATOR = "|";

/**
 * Derive the lane certification identity fingerprint from a registry provider block.
 * @param {unknown} provider — registry agent.provider ({protocol, baseUrl, apiKeyEnv})
 * @returns {string|null} "<canonical-baseUrl>|<apiKeyEnv>", or null when not derivable
 */
export function providerKeyFor(provider) {
  if (!provider || typeof provider !== "object") return null;
  const { baseUrl, apiKeyEnv } = provider;
  if (typeof baseUrl !== "string" || baseUrl.trim().length === 0) return null;
  if (typeof apiKeyEnv !== "string" || apiKeyEnv.trim().length === 0) return null;
  if (baseUrl.includes(KEY_SEPARATOR) || apiKeyEnv.includes(KEY_SEPARATOR)) return null;
  let url;
  try {
    url = new URL(baseUrl.trim());
  } catch {
    return null; // 不可解析的 baseUrl → 不可派生（fail-closed，不猜测）
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return null;
  // 剥默认端口（WHATWG URL 对 special scheme 通常已剥；显式表达规范化规范）。
  const defaultPort = url.protocol === "https:" ? ":443" : ":80";
  const port = url.port && `:${url.port}` !== defaultPort ? `:${url.port}` : "";
  // path 保留大小写，仅去一个尾斜杠（根 "/" → 空字符串）。userinfo/query/fragment
  // 从不参与拼接（url.hostname/pathname 天然不含它们）——凭据不入指纹。
  let path = url.pathname;
  if (path.endsWith("/")) path = path.slice(0, -1);
  // apiKeyEnv 与 baseUrl 同一 trim 纪律：拼接用 trim 后的变量名（判空已 trim，
  // 拼接不 trim 会让 " K " 与 "K" 产出不同指纹——同一接入方被误判为漂移）。
  return `${url.protocol}//${url.hostname.toLowerCase()}${port}${path}${KEY_SEPARATOR}${apiKeyEnv.trim()}`;
}
