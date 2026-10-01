# ItsDangerous：新人可验证的源码导读：裁判细则

仅裁判读取，不放入被测工作区。满分 100；不是唯一标准文稿，允许多种合理结构与设计。

| 项目 | 权重 | 4 分锚点 | 2 分锚点 |
|---|---:|---|---|
| D1 源码事实 | 35 | 边界、异常、轮换和格式机制均对应当前源码，无不存在的接口 | 整体正确但两处细节未经源码支持 |
| D2 链路与架构 | 25 | dumps/loads穿过混入/序列化/签名/时间校验，解释数据如何变化 | 只列文件职责，缺实际调用顺序 |
| D3 示例与测试 | 20 | 例子可运行，篡改与过期可验证，至少3个真实测试锚点 | 有示例但测试引用或异常处理不完整 |
| D4 新人可读性 | 10 | 由目的到机制再到扩展，说明术语与风险 | 过度贴代码或只给API列表 |
| D5 交付与引用 | 10 | 至少8个精确锚点，版本与裁剪边界透明 | 源码链接笼统或参考不存在 |

## 关键失败条件

- 将签名或base64说成保护明文秘密的加密，或把该库说成JWT/数据库产品。
- 核心调用链或核心API为编造；引用的主要源码文件不存在。

## 事实与可核验答案

- 固定提交096c8d42545d3b68ea21a4f890fb2b2d8979c0bd，2.2.0，BSD-3-Clause；仅提供src/tests/pyproject/license，不代表完整仓库。
- Signer 使用 HMAC 等签名算法保证完整性，不隐藏明文；salt 用于不同用途区分，不是加密密钥替代品。
- Serializer dumps: dump_payload -> make_signer.sign；loads: iter_unsigners.unsign -> load_payload。
- URLSafeSerializerMixin 可在缩小结果时zlib压缩并base64编码，点号前缀标记压缩；不是加密。
- TimestampSigner 添加时间戳；TimedSerializer loads 传 max_age，SignatureExpired 与 BadSignature 需区分。
- 新签名使用secret_keys最后一项；校验尝试可用旧钥；fallback_signers用于旧签名配置的验证，不让新签名继续用旧配置。

## 人工／浏览器检查

1. 用随附代码逐项核查8个位置和3个测试组；签名算法不必强制SHA256，按源码实际默认值评价。
2. 在临时目录设置 PYTHONPATH=<工作区>/inputs/repository/src 运行示例。
3. 到期测试用受控TimestampSigner或受控时间，避免无界sleep。
