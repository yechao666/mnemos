# 隐私规则库目录（v6.3 / schema v9）

> **唯一事实来源**：`server/src/db/privacy-catalog.ts`。本文由该文件生成（`PRIVACY_GROUPS` +
> `PRIVACY_CATALOG`），仅用于阅读/评审；新增或修改规则请改源文件，再重新生成本文。
>
> 规则库采用 **18 个行业/领域分组 × 85 条内置规则**；默认只启用 4 条高置信度通用规则
> （`email` / `id_card` / `phone` / `bank_card`），其余规则按**分组**启用（分区覆盖，见
> [`privacy-rules.md`](privacy-rules.md#13-规则库分组与整组启停)）。

## 目录统计

| 维度 | 数量 | 说明 |
| --- | --- | --- |
| 分组 | 18 | 按行业/领域划分，`privacy_rule_groups` 表 |
| 规则 | 85 | `privacy_rules` 表中的 global + builtin 规则 |
| `regex` / `prompt` | 68 / 17 | regex 直接扫描；prompt 交 LLM 抽取（需 `privacyLlmEnabled` + LLM） |
| 默认启用 | 4 | `email` / `phone` / `id_card` / `bank_card`（均为 regex） |
| severity | high 51 / medium 33 / low 1 | 元数据，用于 UI 排序与告警，不改变扫描行为 |
| 校验器 | 15 种 | `btc` / `cn_id` / `coordinates` / `eth` / `iban` / `ipv4` / `ipv6` / `jwt` / `luhn` / `mac` / `us_itin` / `us_ssn` / `uscc` / `uuid` / `vin` |
| 上下文关键词 | 38 条规则启用 | 命中值前后 32 字符窗口内需出现其一（大小写不敏感） |

## 分组总览

| # | key | 名称 | 行业 | 说明 | 规则数 | 默认启用 |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | `common` | 通用个人信息 | 通用 | 姓名、地址、生日、邮编等自然人基础信息。 | 4 | — |
| 2 | `contact` | 联系方式 | 通用 | 邮箱、手机号、座机、国际号码、微信号。 | 5 | `email`、`phone` |
| 3 | `identity_cn` | 中国证件 | 政务 / 实名 | 身份证、护照、港澳台通行证、驾驶证、社保/医保等。 | 11 | `id_card` |
| 4 | `identity_intl` | 国际证件 | 跨境 / 合规 | SSN、ITIN、护照、VAT 等国际证件与税号。 | 5 | — |
| 5 | `finance` | 金融支付 | 金融 | 银行卡、信用卡、CVV、IBAN、SWIFT、证券/基金/保单/发票。 | 11 | `bank_card` |
| 6 | `healthcare` | 医疗健康 | 医疗 | 病历号、医保卡、处方、检验单、诊断/用药/指标/基因。 | 8 | — |
| 7 | `hr` | 人力资源 | HR | 工号、薪资、绩效等员工敏感信息。 | 3 | — |
| 8 | `ecommerce` | 电商零售 | 电商 | 订单号、运单号、收件人信息。 | 3 | — |
| 9 | `internet` | 网络与设备 | 互联网 | IP、MAC、Android ID、广告标识等设备/网络标识。 | 5 | — |
| 10 | `credentials` | 账号凭据 | 安全 | 密码、API Key、JWT、私钥、连接串、验证码。 | 7 | — |
| 11 | `education` | 教育 | 教育 | 学号、准考证号、成绩。 | 3 | — |
| 12 | `legal` | 法律政务 | 法律 / 政务 | 案号、合同号、律师证、统一社会信用代码。 | 5 | — |
| 13 | `automotive` | 汽车交通 | 汽车 | 车牌、VIN、发动机号。 | 3 | — |
| 14 | `location` | 位置信息 | LBS | 经纬度、geohash 等精确位置。 | 2 | — |
| 15 | `biometric` | 生物特征 | 安全 / 医疗 | 指纹、人脸、虹膜、声纹、DNA 等。 | 1 | — |
| 16 | `crypto` | 区块链 | Web3 | ETH/BTC 地址、私钥、助记词。 | 4 | — |
| 17 | `telecom` | 通信 | 运营商 | IMEI、IMSI、ICCID、国际号码。 | 3 | — |
| 18 | `realestate` | 房产 | 地产 | 房产证/不动产权证号、产权人信息。 | 2 | — |

## 规则明细

字段说明：`kind` 为 `regex` 时「匹配规则」是正则源码（`flags` 非 `g` 时标注）；为 `prompt` 时是
给 LLM 的抽取说明。「校验器」为结构/校验位校验（`—` 表示只靠正则 + 上下文）；「上下文」为
`contextKeywords`（命中值附近需出现其一）；「默认」是内置默认启用状态；`severity` 取 `low` /
`medium` / `high`。`caseSensitive` 默认 `true`，本目录内没有规则把它设为 `false`；`region` 为
业务区域标注（`global` 表示通用），不参与扫描。

### 1. 通用个人信息（`common`）

> 行业：通用 · 排序：10 · 规则数：4 · 默认启用：无。姓名、地址、生日、邮编等自然人基础信息。

| code | 名称 | kind | 匹配规则（pattern / instruction） | 校验器 | 上下文关键词 | region | 默认 | severity |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `person_name` | 人名 | prompt | 识别人名：中文姓名、英文姓名（含称呼）；返回原文中出现的姓名。 | — | — | global | 关闭 | high |
| `address` | 详细地址 | prompt | 识别详细地址：省市区、街道、门牌号、楼层房间、小区等。 | — | — | global | 关闭 | high |
| `birth_date` | 出生日期 | regex | `(?<!\d)((?:19\|20)\d{2})[-/.](0?[1-9]\|1[0-2])[-/.](0?[1-9]\|[12]\d\|3[01])(?!\d)` | — | — | global | 关闭 | medium |
| `postal_code_cn` | 中国邮编 | regex | `(?<!\d)[1-9]\d{5}(?!\d)` | — | `邮编`、`邮政编码` | global | 关闭 | low |

### 2. 联系方式（`contact`）

> 行业：通用 · 排序：20 · 规则数：5 · 默认启用：`email`、`phone`。邮箱、手机号、座机、国际号码、微信号。

| code | 名称 | kind | 匹配规则（pattern / instruction） | 校验器 | 上下文关键词 | region | 默认 | severity |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `email` | 邮箱 | regex | `[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}` | — | — | global | ✅ 启用 | high |
| `phone` | 手机号 | regex | `(?<!\d)1[3-9]\d{9}(?!\d)` | — | — | global | ✅ 启用 | high |
| `phone_intl` | 国际电话号码 | regex | `(?<!\d)\+\d{1,3}[- ]?\d{6,14}(?!\d)` | — | — | global | 关闭 | medium |
| `landline_cn` | 中国座机号 | regex | `(?<!\d)0\d{2,3}-\d{7,8}(?!\d)` | — | — | global | 关闭 | medium |
| `wechat_id` | 微信号 | prompt | 识别微信号、企业微信账号、QQ 号等即时通讯账号。 | — | — | global | 关闭 | medium |

### 3. 中国证件（`identity_cn`）

> 行业：政务 / 实名 · 排序：30 · 规则数：11 · 默认启用：`id_card`。身份证、护照、港澳台通行证、驾驶证、社保/医保等。

| code | 名称 | kind | 匹配规则（pattern / instruction） | 校验器 | 上下文关键词 | region | 默认 | severity |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `id_card` | 身份证号 | regex | `(?<![0-9A-Za-z])(\d{17}[\dXx])(?![0-9A-Za-z])` | `cn_id` | — | global | ✅ 启用 | high |
| `passport_cn` | 中国护照号 | regex | `(?<![A-Za-z0-9])[EG]\d{8}(?![A-Za-z0-9])` | — | — | global | 关闭 | high |
| `hk_macau_pass` | 港澳通行证 | regex | `(?<![A-Za-z0-9])[CW]\d{8}(?![A-Za-z0-9])` | — | `港澳`、`通行证` | global | 关闭 | high |
| `taiwan_pass` | 台湾通行证 | regex | `(?<![A-Za-z0-9])\d{8}(?![A-Za-z0-9])` | — | `台胞证`、`台湾通行证` | global | 关闭 | high |
| `driver_license_cn` | 中国驾驶证号 | regex | `(?<!\d)\d{12}(?!\d)` | — | `驾驶证`、`驾照` | global | 关闭 | high |
| `vehicle_license_cn` | 行驶证号 | regex | `(?<!\d)\d{12}(?!\d)` | — | `行驶证` | global | 关闭 | medium |
| `social_security_cn` | 社保号 | regex | `(?<!\d)\d{18}(?!\d)` | — | `社保`、`社会保障` | global | 关闭 | high |
| `medical_insurance_cn` | 医保卡号 | regex | `(?<![A-Za-z0-9])[A-Z]{0,2}\d{8,12}(?![A-Za-z0-9])` | — | `医保` | global | 关闭 | high |
| `military_id` | 军官证/士兵证 | regex | `(?<![A-Za-z0-9])[\u4e00-\u9fa5]{0,2}\d{6,8}(?![A-Za-z0-9])` | — | `军官证`、`士兵证` | global | 关闭 | high |
| `residence_permit` | 居住证号 | regex | `(?<!\d)\d{18}(?!\d)` | — | `居住证` | global | 关闭 | high |
| `org_code_cn` | 组织机构代码 | regex | `(?<![A-Za-z0-9])[A-Z0-9]{8}-[A-Z0-9](?![A-Za-z0-9])` | — | — | global | 关闭 | medium |

### 4. 国际证件（`identity_intl`）

> 行业：跨境 / 合规 · 排序：40 · 规则数：5 · 默认启用：无。SSN、ITIN、护照、VAT 等国际证件与税号。

| code | 名称 | kind | 匹配规则（pattern / instruction） | 校验器 | 上下文关键词 | region | 默认 | severity |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `us_ssn` | 美国 SSN | regex | `(?<!\d)\d{3}-\d{2}-\d{4}(?!\d)` | `us_ssn` | — | US | 关闭 | high |
| `us_itin` | 美国 ITIN | regex | `(?<!\d)9\d{2}-[78]\d-\d{4}(?!\d)` | `us_itin` | — | US | 关闭 | high |
| `passport_intl` | 国际护照号 | regex | `(?<![A-Za-z0-9])[A-Z]{1,2}\d{6,9}(?![A-Za-z0-9])` | — | `护照`、`passport` | global | 关闭 | high |
| `eu_vat` | 欧盟 VAT 号 | regex | `(?<![A-Za-z0-9])[A-Z]{2}\d{8,12}(?![A-Za-z0-9])` | — | `VAT`、`vat`、`增值税` | EU | 关闭 | medium |
| `national_id_prompt` | 其他国家证件/税号 | prompt | 识别各国身份证、居留证、税号、护照等政府签发证件号码（非中国身份证）。 | — | — | global | 关闭 | high |

### 5. 金融支付（`finance`）

> 行业：金融 · 排序：50 · 规则数：11 · 默认启用：`bank_card`。银行卡、信用卡、CVV、IBAN、SWIFT、证券/基金/保单/发票。

| code | 名称 | kind | 匹配规则（pattern / instruction） | 校验器 | 上下文关键词 | region | 默认 | severity |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `bank_card` | 银行卡号 | regex | `(?<!\d)(\d{16,19})(?!\d)` | `luhn` | — | global | ✅ 启用 | high |
| `credit_card` | 信用卡号 | regex | `(?<!\d)(?:4\d{12}(?:\d{3})?\|5[1-5]\d{14}\|3[47]\d{13}\|6(?:011\|5\d{2})\d{12})(?!\d)` | `luhn` | — | global | 关闭 | high |
| `cvv` | CVV/CVC 安全码 | regex | `(?<!\d)\d{3,4}(?!\d)` | — | `CVV`、`CVC`、`安全码`、`cvv` | global | 关闭 | high |
| `iban` | IBAN | regex | `(?<![A-Za-z0-9])[A-Z]{2}\d{2}[A-Z0-9]{11,30}(?![A-Za-z0-9])` | `iban` | — | global | 关闭 | high |
| `swift_bic` | SWIFT/BIC | regex | `(?<![A-Za-z0-9])[A-Z]{6}[A-Z0-9]{2}(?:[A-Z0-9]{3})?(?![A-Za-z0-9])` | — | `SWIFT`、`BIC` | global | 关闭 | medium |
| `bank_account_cn` | 银行账号 | regex | `(?<!\d)\d{16,19}(?!\d)` | — | `银行账号`、`开户`、`卡号` | global | 关闭 | high |
| `securities_account` | 证券资金账号 | regex | `(?<!\d)\d{10}(?!\d)` | — | `证券`、`资金账户` | global | 关闭 | high |
| `fund_account` | 基金账号 | regex | `(?<!\d)\d{12}(?!\d)` | — | `基金账户`、`基金账号` | global | 关闭 | high |
| `insurance_policy` | 保单号 | regex | `(?<![A-Za-z0-9])[A-Z]{1,3}\d{8,12}(?![A-Za-z0-9])` | — | `保单` | global | 关闭 | medium |
| `invoice_no` | 发票号码 | regex | `(?<!\d)\d{8,20}(?!\d)` | — | `发票号码`、`发票号` | global | 关闭 | medium |
| `tax_no_cn` | 纳税人识别号 | regex | `(?<![A-Za-z0-9])[A-Z0-9]{15,20}(?![A-Za-z0-9])` | — | `税号`、`纳税人` | global | 关闭 | medium |

### 6. 医疗健康（`healthcare`）

> 行业：医疗 · 排序：60 · 规则数：8 · 默认启用：无。病历号、医保卡、处方、检验单、诊断/用药/指标/基因。

| code | 名称 | kind | 匹配规则（pattern / instruction） | 校验器 | 上下文关键词 | region | 默认 | severity |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `medical_record_no` | 病历号/住院号 | regex | `(?<![A-Za-z0-9])[A-Z]{0,2}\d{6,12}(?![A-Za-z0-9])` | — | `病历`、`住院号` | global | 关闭 | high |
| `insurance_card_no` | 医保卡号 | regex | `(?<!\d)\d{8,12}(?!\d)` | — | `医保卡` | global | 关闭 | high |
| `prescription_no` | 处方号 | regex | `(?<![A-Za-z0-9])[A-Z]{0,2}\d{6,12}(?![A-Za-z0-9])` | — | `处方` | global | 关闭 | medium |
| `lab_report_no` | 检验报告单号 | regex | `(?<![A-Za-z0-9])[A-Z]{0,2}\d{6,12}(?![A-Za-z0-9])` | — | `检验报告`、`报告单` | global | 关闭 | medium |
| `diagnosis` | 诊断/病情 | prompt | 识别疾病名称、诊断结论、症状、病史等健康信息。 | — | — | global | 关闭 | high |
| `medication` | 用药信息 | prompt | 识别药品名称、剂量、用药方案、过敏药物等。 | — | — | global | 关闭 | high |
| `health_metric` | 体检指标 | prompt | 识别血压、血糖、血脂、BMI、检验指标等健康测量值。 | — | — | global | 关闭 | high |
| `genetic` | 基因信息 | prompt | 识别基因位点、遗传病、基因检测结果等基因信息。 | — | — | global | 关闭 | high |

### 7. 人力资源（`hr`）

> 行业：HR · 排序：70 · 规则数：3 · 默认启用：无。工号、薪资、绩效等员工敏感信息。

| code | 名称 | kind | 匹配规则（pattern / instruction） | 校验器 | 上下文关键词 | region | 默认 | severity |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `employee_id` | 工号 | regex | `(?<![A-Za-z0-9])(?:EMP\|E)[-_]?\d{4,10}(?![A-Za-z0-9])`（flags: `gi`） | — | — | global | 关闭 | medium |
| `salary` | 薪资/薪酬 | prompt | 识别工资、月薪、年薪、奖金、期权、社保公积金缴纳基数等薪酬信息。 | — | — | global | 关闭 | high |
| `performance` | 绩效/考核 | prompt | 识别绩效评分、考核结果、晋升/淘汰结论、员工评价等。 | — | — | global | 关闭 | high |

### 8. 电商零售（`ecommerce`）

> 行业：电商 · 排序：80 · 规则数：3 · 默认启用：无。订单号、运单号、收件人信息。

| code | 名称 | kind | 匹配规则（pattern / instruction） | 校验器 | 上下文关键词 | region | 默认 | severity |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `order_no` | 订单号 | regex | `(?<![A-Za-z0-9])\d{12,20}(?![A-Za-z0-9])` | — | `订单`、`order` | global | 关闭 | medium |
| `tracking_no` | 快递/运单号 | regex | `(?<![A-Za-z0-9])[A-Z]{2}\d{9,13}(?![A-Za-z0-9])` | — | `快递`、`运单`、`物流` | global | 关闭 | medium |
| `recipient` | 收件人信息 | prompt | 识别收件人/收货人姓名、电话、地址组合等物流面单信息。 | — | — | global | 关闭 | high |

### 9. 网络与设备（`internet`）

> 行业：互联网 · 排序：90 · 规则数：5 · 默认启用：无。IP、MAC、Android ID、广告标识等设备/网络标识。

| code | 名称 | kind | 匹配规则（pattern / instruction） | 校验器 | 上下文关键词 | region | 默认 | severity |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `ipv4` | IPv4 地址 | regex | `(?<!\d)(?:\d{1,3}\.){3}\d{1,3}(?!\d)` | `ipv4` | — | global | 关闭 | medium |
| `ipv6` | IPv6 地址 | regex | `(?<![0-9A-Fa-f:])(?:[0-9A-Fa-f]{1,4}:){2,7}[0-9A-Fa-f]{1,4}(?![0-9A-Fa-f:])` | `ipv6` | — | global | 关闭 | medium |
| `mac` | MAC 地址 | regex | `(?<![0-9A-Fa-f])(?:[0-9A-Fa-f]{2}[:-]){5}[0-9A-Fa-f]{2}(?![0-9A-Fa-f])` | `mac` | — | global | 关闭 | medium |
| `android_id` | Android ID | regex | `(?<![0-9A-f])[0-9a-f]{16}(?![0-9a-f])` | — | `Android ID`、`android_id` | global | 关闭 | medium |
| `advertising_id` | 广告标识（IDFA/GAID） | regex | `(?<![0-9a-fA-F])[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}(?![0-9a-fA-F])` | `uuid` | `IDFA`、`GAID`、`广告标识`、`设备标识` | global | 关闭 | medium |

### 10. 账号凭据（`credentials`）

> 行业：安全 · 排序：100 · 规则数：7 · 默认启用：无。密码、API Key、JWT、私钥、连接串、验证码。

| code | 名称 | kind | 匹配规则（pattern / instruction） | 校验器 | 上下文关键词 | region | 默认 | severity |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `credential` | 账号/密码 | prompt | 识别账号、密码、API Key、Token、验证码、密钥等凭据。 | — | — | global | 关闭 | high |
| `api_key` | API Key | regex | `(?<![A-Za-z0-9])(?:sk-[A-Za-z0-9]{20,}\|AKIA[0-9A-Z]{16}\|ghp_[A-Za-z0-9]{36}\|xox[baprs]-[A-Za-z0-9-]{10,})(?![A-Za-z0-9])` | — | — | global | 关闭 | high |
| `jwt` | JWT | regex | `(?<![A-Za-z0-9_-])eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}(?![A-Za-z0-9_-])` | `jwt` | — | global | 关闭 | high |
| `private_key` | 私钥（PEM） | regex | `-----BEGIN (?:RSA \|EC \|OPENSSH \|DSA )?PRIVATE KEY-----[\s\S]+?-----END (?:RSA \|EC \|OPENSSH \|DSA )?PRIVATE KEY-----` | — | — | global | 关闭 | high |
| `bearer_token` | Bearer Token | regex | `\bBearer\s+[A-Za-z0-9._~+/=-]{10,}`（flags: `gi`） | — | — | global | 关闭 | high |
| `database_url` | 数据库/连接串 | regex | `(?<![A-Za-z0-9])(?:postgres\|postgresql\|mysql\|mongodb\|redis\|amqp):\/\/[^\s:@/]+:[^\s@/]+@[^\s]+`（flags: `gi`） | — | — | global | 关闭 | high |
| `otp` | 验证码/OTP | regex | `(?<!\d)\d{4,8}(?!\d)` | — | `验证码`、`OTP`、`一次性` | global | 关闭 | high |

### 11. 教育（`education`）

> 行业：教育 · 排序：110 · 规则数：3 · 默认启用：无。学号、准考证号、成绩。

| code | 名称 | kind | 匹配规则（pattern / instruction） | 校验器 | 上下文关键词 | region | 默认 | severity |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `student_id` | 学号 | regex | `(?<![A-Za-z0-9])\d{6,12}(?![A-Za-z0-9])` | — | `学号` | global | 关闭 | medium |
| `exam_no` | 准考证号 | regex | `(?<![A-Za-z0-9])\d{8,15}(?![A-Za-z0-9])` | — | `准考证` | global | 关闭 | medium |
| `score` | 成绩/排名 | prompt | 识别考试分数、排名、录取结果、评语等教育结果信息。 | — | — | global | 关闭 | medium |

### 12. 法律政务（`legal`）

> 行业：法律 / 政务 · 排序：120 · 规则数：5 · 默认启用：无。案号、合同号、律师证、统一社会信用代码。

| code | 名称 | kind | 匹配规则（pattern / instruction） | 校验器 | 上下文关键词 | region | 默认 | severity |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `case_no` | 案号 | regex | `(?<![A-Za-z0-9])[（(]\d{4}[）)]\d{1,4}[\u4e00-\u9fa5]{1,6}\d{1,6}号(?![A-Za-z0-9])` | — | — | global | 关闭 | high |
| `contract_no` | 合同编号 | regex | `(?<![A-Za-z0-9])[A-Z]{2,4}[-_]?\d{6,12}(?![A-Za-z0-9])` | — | `合同` | global | 关闭 | medium |
| `lawyer_license` | 律师执业证号 | regex | `(?<!\d)\d{17}(?![A-Za-z0-9])` | — | `律师执业证`、`律师证` | global | 关闭 | high |
| `unified_social_credit` | 统一社会信用代码 | regex | `(?<![A-Za-z0-9])[0-9A-HJ-NPQRTUWXY]{2}\d{6}[0-9A-HJ-NPQRTUWXY]{10}(?![A-Za-z0-9])` | `uscc` | — | global | 关闭 | medium |
| `court_doc` | 法律文书内容 | prompt | 识别判决书/起诉状中的当事人、案由、证据、判决结果等敏感法律内容。 | — | — | global | 关闭 | high |

### 13. 汽车交通（`automotive`）

> 行业：汽车 · 排序：130 · 规则数：3 · 默认启用：无。车牌、VIN、发动机号。

| code | 名称 | kind | 匹配规则（pattern / instruction） | 校验器 | 上下文关键词 | region | 默认 | severity |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `license_plate_cn` | 中国车牌号 | regex | `(?<![A-Za-z0-9\u4e00-\u9fa5])[\u4e00-\u9fa5][A-HJ-NP-Z][A-HJ-NP-Z0-9]{4,5}[A-HJ-NP-Z0-9\u4e00-\u9fa5](?![A-Za-z0-9\u4e00-\u9fa5])` | — | — | global | 关闭 | high |
| `vin` | 车架号 VIN | regex | `(?<![A-Za-z0-9])[A-HJ-NPR-Z0-9]{17}(?![A-Za-z0-9])` | `vin` | — | global | 关闭 | high |
| `engine_no` | 发动机号 | regex | `(?<![A-Za-z0-9])[A-Z0-9]{6,17}(?![A-Za-z0-9])` | — | `发动机号`、`发动机` | global | 关闭 | medium |

### 14. 位置信息（`location`）

> 行业：LBS · 排序：140 · 规则数：2 · 默认启用：无。经纬度、geohash 等精确位置。

| code | 名称 | kind | 匹配规则（pattern / instruction） | 校验器 | 上下文关键词 | region | 默认 | severity |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `coordinates` | 经纬度坐标 | regex | `(?<!\d)(-?\d{1,3}\.\d{3,})\s*[,，]\s*(-?\d{1,3}\.\d{3,})(?!\d)` | `coordinates` | — | global | 关闭 | high |
| `geohash` | Geohash | regex | `(?<![A-Za-z0-9])[0-9bcdefghjkmnpqrstuvwxyz]{6,12}(?![A-Za-z0-9])` | — | `geohash`、`坐标` | global | 关闭 | medium |

### 15. 生物特征（`biometric`）

> 行业：安全 / 医疗 · 排序：150 · 规则数：1 · 默认启用：无。指纹、人脸、虹膜、声纹、DNA 等。

| code | 名称 | kind | 匹配规则（pattern / instruction） | 校验器 | 上下文关键词 | region | 默认 | severity |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `biometric` | 生物特征 | prompt | 识别指纹、人脸、虹膜、声纹、掌纹、DNA 等生物特征信息。 | — | — | global | 关闭 | high |

### 16. 区块链（`crypto`）

> 行业：Web3 · 排序：160 · 规则数：4 · 默认启用：无。ETH/BTC 地址、私钥、助记词。

| code | 名称 | kind | 匹配规则（pattern / instruction） | 校验器 | 上下文关键词 | region | 默认 | severity |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `eth_address` | ETH 地址 | regex | `(?<![0-9A-Fa-f])0x[0-9A-Fa-f]{40}(?![0-9A-Fa-f])` | `eth` | — | global | 关闭 | medium |
| `btc_address` | BTC 地址 | regex | `(?<![A-Za-z0-9])[13][a-km-zA-HJ-NP-Z1-9]{25,34}(?![A-Za-z0-9])` | `btc` | — | global | 关闭 | medium |
| `crypto_private_key` | 区块链私钥 | regex | `(?<![0-9A-Fa-f])[0-9A-Fa-f]{64}(?![0-9A-Fa-f])` | — | `私钥`、`private key` | global | 关闭 | high |
| `mnemonic` | 助记词 | prompt | 识别 12/24 个英文单词组成的钱包助记词（seed phrase）。 | — | — | global | 关闭 | high |

### 17. 通信（`telecom`）

> 行业：运营商 · 排序：170 · 规则数：3 · 默认启用：无。IMEI、IMSI、ICCID、国际号码。

| code | 名称 | kind | 匹配规则（pattern / instruction） | 校验器 | 上下文关键词 | region | 默认 | severity |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `imei` | IMEI | regex | `(?<!\d)\d{15}(?!\d)` | `luhn` | — | global | 关闭 | medium |
| `imsi` | IMSI | regex | `(?<!\d)\d{15}(?!\d)` | — | `IMSI` | global | 关闭 | medium |
| `iccid` | ICCID（SIM 卡号） | regex | `(?<!\d)\d{19,20}(?!\d)` | — | `ICCID` | global | 关闭 | medium |

### 18. 房产（`realestate`）

> 行业：地产 · 排序：180 · 规则数：2 · 默认启用：无。房产证/不动产权证号、产权人信息。

| code | 名称 | kind | 匹配规则（pattern / instruction） | 校验器 | 上下文关键词 | region | 默认 | severity |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `property_cert_no` | 房产证/不动产权证号 | regex | `(?<![A-Za-z0-9])[A-Za-z0-9]{6,20}(?![A-Za-z0-9])` | — | `房产证`、`不动产权` | global | 关闭 | high |
| `property_owner` | 产权人信息 | prompt | 识别房产证/购房合同中的产权人姓名、证件号、共有情况、房产地址。 | — | — | global | 关闭 | high |

## 附录：校验器 → 规则

| validator | 语义（详见 [`privacy-rules.md`](privacy-rules.md#33-校验器与语义)） | 使用规则 |
| --- | --- | --- |
| `btc` | BTC 地址 Base58Check 校验 | `btc_address` |
| `cn_id` | GB 11643 身份证校验位 + 出生日期合法性 | `id_card` |
| `coordinates` | 经纬度范围（-90..90 / -180..180） | `coordinates` |
| `eth` | ETH 地址 0x + 40 hex | `eth_address` |
| `iban` | IBAN mod-97 校验 | `iban` |
| `ipv4` | IPv4 点分十进制合法性 | `ipv4` |
| `ipv6` | IPv6 地址合法性（node:net） | `ipv6` |
| `jwt` | JWT 三段结构 + header 可解析 | `jwt` |
| `luhn` | Luhn 校验位（银行卡 / 信用卡 / IMEI） | `bank_card`、`credit_card`、`imei` |
| `mac` | MAC 地址 6 段十六进制合法性 | `mac` |
| `us_itin` | 美国 ITIN 结构校验（9xx-7x/8x） | `us_itin` |
| `us_ssn` | 美国 SSN 结构校验（禁用区段/重复位） | `us_ssn` |
| `uscc` | 统一社会信用代码 mod-31 校验 | `unified_social_credit` |
| `uuid` | UUID v4/标准 8-4-4-4-12 结构 | `advertising_id` |
| `vin` | VIN 17 位 + 第 9 位校验码 | `vin` |

## 默认策略与启用建议

- **默认只启用 4 条**：`email`、`id_card`、`phone`、`bank_card`，与 v6.2 的写死 `basic` 语义兼容，
  覆盖最高频、低误报的通用 PII；其余 81 条全部默认关闭。
- **按组启用**：控制台隐私规则页的「规则库」视图对 18 个分组提供「启用本组 / 停用本组」；
  API 为 `POST /api/privacy/groups/:key/apply`（`/v1/partitions/:p/privacy/groups/:key/apply`）。
  启用组 = 对该组每条全局规则写一条 `scope=partition` 覆盖（`enabled=true`）；停用组 = 覆盖为
  `enabled=false`。整组启停只影响当前分区，不改全局目录。
- **prompt 规则**（17 条）还需 `privacyLlmEnabled=true` 且配置可用 LLM，否则只落库不扫描；
  失败静默回退 regex，不影响写入。
- **启用顺序建议**：`contact` → `identity_cn` → `finance` → 行业相关组（医疗/HR/法律/房产等）。
  `identity_intl`（US/EU）仅在跨境业务启用；`credentials` / `crypto` / `biometric` 误报代价高，
  建议先在 preview 中验证真实样本。
- **启用后重扫**：规则变更只影响新写入；存量记忆需 `POST /api/partitions/:p/privacy/rescan`
  （或 `POST /api/ops/jobs/tick`）才会按新规则处理。

## 误报边界与调优建议

### 高误报风险规则（无校验器、纯数字/短串）

以下规则没有 `validator`，正则本身无法排除普通数字，**强依赖 `contextKeywords`**，建议保持默认关闭
或先 preview 后再启用：

| code | 组 | 风险 | 依赖 |
| --- | --- | --- | --- |
| `postal_code_cn` | `common` | 任意 6 位数字（可能命中编号/金额） | 上下文 `邮编` / `邮政编码` |
| `taiwan_pass` | `identity_cn` | 任意 8 位数字 | 上下文 `台胞证` / `台湾通行证` |
| `driver_license_cn` | `identity_cn` | 任意 12 位数字 | 上下文 `驾驶证` / `驾照` |
| `vehicle_license_cn` | `identity_cn` | 任意 12 位数字 | 上下文 `行驶证` |
| `social_security_cn` | `identity_cn` | 任意 18 位数字 | 上下文 `社保` / `社会保障` |
| `residence_permit` | `identity_cn` | 任意 18 位数字 | 上下文 `居住证` |
| `medical_insurance_cn` | `identity_cn` | 字母+8~12 位数字 | 上下文 `医保` |
| `bank_account_cn` | `finance` | 16~19 位数字（与银行卡重叠） | 上下文 `银行账号` / `开户` / `卡号` |
| `securities_account` | `finance` | 任意 10 位数字 | 上下文 `证券` / `资金账户` |
| `fund_account` | `finance` | 任意 12 位数字 | 上下文 `基金账户` / `基金账号` |
| `invoice_no` | `finance` | 8~20 位数字 | 上下文 `发票号码` / `发票号` |
| `cvv` | `finance` | 任意 3~4 位数字 | 上下文 `CVV` / `CVC` / `安全码` |
| `otp` | `credentials` | 任意 4~8 位数字 | 上下文 `验证码` / `OTP` / `一次性` |
| `student_id` | `education` | 6~12 位数字 | 上下文 `学号` |
| `exam_no` | `education` | 8~15 位数字 | 上下文 `准考证` |
| `order_no` | `ecommerce` | 12~20 位数字 | 上下文 `订单` / `order` |
| `android_id` | `internet` | 16 位小写 hex | 上下文 `Android ID` / `android_id` |
| `geohash` | `location` | 6~12 位字母数字 | 上下文 `geohash` / `坐标` |
| `property_cert_no` | `realestate` | 6~20 位字母数字 | 上下文 `房产证` / `不动产权` |
| `medical_record_no` | `healthcare` | 字母+6~12 位数字 | 上下文 `病历` / `住院号` |

### 边界与优先级

- **校验器是硬门槛**：`validator` 不通过时该命中被跳过（不会降级为低置信命中）。例如 18 位数字
  若不是合法身份证（校验位/日期不符），`id_card` 不命中；但它仍可能被 `bank_card`（16~19 位 +
  Luhn）或 `social_security_cn`（若启用且上下文命中）命中，属预期行为。
- **上下文窗口**：关键词必须出现在命中值前后 **32 个字符**内，且大小写不敏感；跨句/跨段不算。
  关键词过窄会漏报（如只写「邮编」但正文是「Postal Code」），过宽仍可能误报。
- **priority 小者先执行**：已被替换/占位的片段不会被后续规则再次命中。目录中 `email`(10) <
  `id_card`(20) < `phone`(30) < `bank_card`(40)，与旧 `basic` 顺序一致；rest 在 210–621 之间。
- **组内/跨组重叠**：`bank_card` 与 `credit_card`、`bank_account_cn`；`medical_insurance_cn`（中国证件）
  与 `insurance_card_no`（医疗健康）；`person_name` 与 `address`（prompt）。同一段文本可能产生多条
  不同 `code` 的命中，写库时按各自 action 处理，不会互相回滚。
- **大小写**：catalog 默认 `caseSensitive=true`；`employee_id` / `bearer_token` / `database_url` 通过
  `flags=gi` 做大小写不敏感匹配。自定义规则可显式设 `caseSensitive=false`，引擎会补 `i` 标志。
- **region 不参与扫描**：`US` / `EU` 只是业务标注，用于 UI 分组与启用决策；是否扫描由 `enabled` 决定。
- **severity 不改变行为**：仅用于排序/告警；是否打码只由 `enabled` + 规则命中决定。
- **mask vs placeholder**：目录默认 `action=mask`（不可逆，适合展示/检索）；需要可逆抽离（如
  回填给 LLM）时把规则改为 `action=placeholder`，正文只存 `{{token}}`。
- **先 preview 再启用**：`POST /api/privacy/preview` 不落库，建议用真实样本观察命中与替换结果；
  启用组后可用 `rescan` 回扫存量，再在记忆详情核对 `placeholderCount` 与审计。
