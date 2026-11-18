/**
 * v6.3 隐私规则库（schema v9）：按行业/领域分组的内置规则目录。
 *
 * - 规则默认只启用 4 条高置信度通用规则（email / id_card / phone / bank_card），
 *   其余作为「规则库」按分组一键启用（分区覆盖），避免默认误伤。
 * - kind=regex 直接扫描；kind=prompt 交给 LLM 抽取（需 privacyLlmEnabled + LLM）。
 * - validator 用于校验结构/校验位，降低误报（luhn/cn_id/uscc/iban/vin/ipv4/ipv6/mac/jwt/eth/btc/coordinates/uuid/us_ssn/us_itin）。
 */

export interface PrivacyCatalogGroup {
  key: string;
  name: string;
  industry: string;
  description: string;
  sortOrder: number;
}

export interface PrivacyCatalogRule {
  code: string;
  name: string;
  groupKey: string;
  kind: 'regex' | 'prompt';
  pattern?: string;
  flags?: string;
  instruction?: string;
  entityType: string;
  action?: 'mask' | 'placeholder';
  maskMode?: 'email' | 'keepFirstLast' | 'keepLast' | 'full';
  maskKeepFirst?: number;
  maskKeepLast?: number;
  priority: number;
  enabled?: boolean;
  validator?: string;
  contextKeywords?: string[];
  caseSensitive?: boolean;
  region?: string;
  severity?: 'low' | 'medium' | 'high';
}

export const PRIVACY_GROUPS: PrivacyCatalogGroup[] = [
  { key: 'common', name: '通用个人信息', industry: '通用', description: '姓名、地址、生日、邮编等自然人基础信息。', sortOrder: 10 },
  { key: 'contact', name: '联系方式', industry: '通用', description: '邮箱、手机号、座机、国际号码、微信号。', sortOrder: 20 },
  { key: 'identity_cn', name: '中国证件', industry: '政务 / 实名', description: '身份证、护照、港澳台通行证、驾驶证、社保/医保等。', sortOrder: 30 },
  { key: 'identity_intl', name: '国际证件', industry: '跨境 / 合规', description: 'SSN、ITIN、护照、VAT 等国际证件与税号。', sortOrder: 40 },
  { key: 'finance', name: '金融支付', industry: '金融', description: '银行卡、信用卡、CVV、IBAN、SWIFT、证券/基金/保单/发票。', sortOrder: 50 },
  { key: 'healthcare', name: '医疗健康', industry: '医疗', description: '病历号、医保卡、处方、检验单、诊断/用药/指标/基因。', sortOrder: 60 },
  { key: 'hr', name: '人力资源', industry: 'HR', description: '工号、薪资、绩效等员工敏感信息。', sortOrder: 70 },
  { key: 'ecommerce', name: '电商零售', industry: '电商', description: '订单号、运单号、收件人信息。', sortOrder: 80 },
  { key: 'internet', name: '网络与设备', industry: '互联网', description: 'IP、MAC、Android ID、广告标识等设备/网络标识。', sortOrder: 90 },
  { key: 'credentials', name: '账号凭据', industry: '安全', description: '密码、API Key、JWT、私钥、连接串、验证码。', sortOrder: 100 },
  { key: 'education', name: '教育', industry: '教育', description: '学号、准考证号、成绩。', sortOrder: 110 },
  { key: 'legal', name: '法律政务', industry: '法律 / 政务', description: '案号、合同号、律师证、统一社会信用代码。', sortOrder: 120 },
  { key: 'automotive', name: '汽车交通', industry: '汽车', description: '车牌、VIN、发动机号。', sortOrder: 130 },
  { key: 'location', name: '位置信息', industry: 'LBS', description: '经纬度、geohash 等精确位置。', sortOrder: 140 },
  { key: 'biometric', name: '生物特征', industry: '安全 / 医疗', description: '指纹、人脸、虹膜、声纹、DNA 等。', sortOrder: 150 },
  { key: 'crypto', name: '区块链', industry: 'Web3', description: 'ETH/BTC 地址、私钥、助记词。', sortOrder: 160 },
  { key: 'telecom', name: '通信', industry: '运营商', description: 'IMEI、IMSI、ICCID、国际号码。', sortOrder: 170 },
  { key: 'realestate', name: '房产', industry: '地产', description: '房产证/不动产权证号、产权人信息。', sortOrder: 180 },
];

const R = (rule: PrivacyCatalogRule): PrivacyCatalogRule => ({
  action: 'mask',
  maskMode: 'keepLast',
  maskKeepFirst: 0,
  maskKeepLast: 4,
  enabled: false,
  caseSensitive: true,
  region: 'global',
  severity: 'medium',
  ...rule,
});

export const PRIVACY_CATALOG: PrivacyCatalogRule[] = [
  /* ---------------------------- 通用个人信息 ---------------------------- */
  R({ code: 'person_name', name: '人名', groupKey: 'common', kind: 'prompt', entityType: 'name',
    instruction: '识别人名：中文姓名、英文姓名（含称呼）；返回原文中出现的姓名。',
    maskMode: 'keepFirstLast', maskKeepFirst: 1, maskKeepLast: 1, priority: 500, severity: 'high' }),
  R({ code: 'address', name: '详细地址', groupKey: 'common', kind: 'prompt', entityType: 'address',
    instruction: '识别详细地址：省市区、街道、门牌号、楼层房间、小区等。',
    maskMode: 'full', maskKeepFirst: 0, maskKeepLast: 0, priority: 510, severity: 'high' }),
  R({ code: 'birth_date', name: '出生日期', groupKey: 'common', kind: 'regex', entityType: 'birth_date',
    pattern: String.raw`(?<!\d)((?:19|20)\d{2})[-/.](0?[1-9]|1[0-2])[-/.](0?[1-9]|[12]\d|3[01])(?!\d)`,
    maskMode: 'keepFirstLast', maskKeepFirst: 4, maskKeepLast: 0, priority: 210, severity: 'medium' }),
  R({ code: 'postal_code_cn', name: '中国邮编', groupKey: 'common', kind: 'regex', entityType: 'postal_code',
    pattern: String.raw`(?<!\d)[1-9]\d{5}(?!\d)`, contextKeywords: ['邮编', '邮政编码'],
    maskMode: 'full', maskKeepFirst: 0, maskKeepLast: 0, priority: 220, severity: 'low' }),

  /* ------------------------------ 联系方式 ------------------------------ */
  R({ code: 'email', name: '邮箱', groupKey: 'contact', kind: 'regex', entityType: 'email',
    pattern: String.raw`[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}`,
    maskMode: 'email', priority: 10, enabled: true, severity: 'high' }),
  R({ code: 'phone', name: '手机号', groupKey: 'contact', kind: 'regex', entityType: 'phone',
    pattern: String.raw`(?<!\d)1[3-9]\d{9}(?!\d)`,
    maskMode: 'keepFirstLast', maskKeepFirst: 3, maskKeepLast: 4, priority: 30, enabled: true, severity: 'high' }),
  R({ code: 'phone_intl', name: '国际电话号码', groupKey: 'contact', kind: 'regex', entityType: 'phone',
    pattern: String.raw`(?<!\d)\+\d{1,3}[- ]?\d{6,14}(?!\d)`,
    maskMode: 'keepFirstLast', maskKeepFirst: 4, maskKeepLast: 4, priority: 235, severity: 'medium' }),
  R({ code: 'landline_cn', name: '中国座机号', groupKey: 'contact', kind: 'regex', entityType: 'phone',
    pattern: String.raw`(?<!\d)0\d{2,3}-\d{7,8}(?!\d)`,
    maskMode: 'keepFirstLast', maskKeepFirst: 4, maskKeepLast: 4, priority: 240, severity: 'medium' }),
  R({ code: 'wechat_id', name: '微信号', groupKey: 'contact', kind: 'prompt', entityType: 'wechat',
    instruction: '识别微信号、企业微信账号、QQ 号等即时通讯账号。',
    maskMode: 'keepFirstLast', maskKeepFirst: 2, maskKeepLast: 2, priority: 520, severity: 'medium' }),

  /* ------------------------------ 中国证件 ------------------------------ */
  R({ code: 'id_card', name: '身份证号', groupKey: 'identity_cn', kind: 'regex', entityType: 'id_card',
    pattern: String.raw`(?<![0-9A-Za-z])(\d{17}[\dXx])(?![0-9A-Za-z])`, validator: 'cn_id',
    maskMode: 'keepFirstLast', maskKeepFirst: 6, maskKeepLast: 4, priority: 20, enabled: true, severity: 'high' }),
  R({ code: 'passport_cn', name: '中国护照号', groupKey: 'identity_cn', kind: 'regex', entityType: 'passport',
    pattern: String.raw`(?<![A-Za-z0-9])[EG]\d{8}(?![A-Za-z0-9])`,
    maskMode: 'keepFirstLast', maskKeepFirst: 1, maskKeepLast: 4, priority: 250, severity: 'high' }),
  R({ code: 'hk_macau_pass', name: '港澳通行证', groupKey: 'identity_cn', kind: 'regex', entityType: 'passport',
    pattern: String.raw`(?<![A-Za-z0-9])[CW]\d{8}(?![A-Za-z0-9])`, contextKeywords: ['港澳', '通行证'],
    maskMode: 'keepFirstLast', maskKeepFirst: 1, maskKeepLast: 4, priority: 260, severity: 'high' }),
  R({ code: 'taiwan_pass', name: '台湾通行证', groupKey: 'identity_cn', kind: 'regex', entityType: 'passport',
    pattern: String.raw`(?<![A-Za-z0-9])\d{8}(?![A-Za-z0-9])`, contextKeywords: ['台胞证', '台湾通行证'],
    maskMode: 'keepFirstLast', maskKeepFirst: 2, maskKeepLast: 4, priority: 270, severity: 'high' }),
  R({ code: 'driver_license_cn', name: '中国驾驶证号', groupKey: 'identity_cn', kind: 'regex', entityType: 'license',
    pattern: String.raw`(?<!\d)\d{12}(?!\d)`, contextKeywords: ['驾驶证', '驾照'],
    maskMode: 'keepFirstLast', maskKeepFirst: 6, maskKeepLast: 4, priority: 280, severity: 'high' }),
  R({ code: 'vehicle_license_cn', name: '行驶证号', groupKey: 'identity_cn', kind: 'regex', entityType: 'license',
    pattern: String.raw`(?<!\d)\d{12}(?!\d)`, contextKeywords: ['行驶证'],
    maskMode: 'keepFirstLast', maskKeepFirst: 6, maskKeepLast: 4, priority: 281, severity: 'medium' }),
  R({ code: 'social_security_cn', name: '社保号', groupKey: 'identity_cn', kind: 'regex', entityType: 'social_security',
    pattern: String.raw`(?<!\d)\d{18}(?!\d)`, contextKeywords: ['社保', '社会保障'],
    maskMode: 'keepFirstLast', maskKeepFirst: 6, maskKeepLast: 4, priority: 282, severity: 'high' }),
  R({ code: 'medical_insurance_cn', name: '医保卡号', groupKey: 'identity_cn', kind: 'regex', entityType: 'medical_insurance',
    pattern: String.raw`(?<![A-Za-z0-9])[A-Z]{0,2}\d{8,12}(?![A-Za-z0-9])`, contextKeywords: ['医保'],
    maskMode: 'keepFirstLast', maskKeepFirst: 2, maskKeepLast: 4, priority: 283, severity: 'high' }),
  R({ code: 'military_id', name: '军官证/士兵证', groupKey: 'identity_cn', kind: 'regex', entityType: 'military_id',
    pattern: String.raw`(?<![A-Za-z0-9])[\u4e00-\u9fa5]{0,2}\d{6,8}(?![A-Za-z0-9])`, contextKeywords: ['军官证', '士兵证'],
    maskMode: 'keepFirstLast', maskKeepFirst: 2, maskKeepLast: 3, priority: 284, severity: 'high' }),
  R({ code: 'residence_permit', name: '居住证号', groupKey: 'identity_cn', kind: 'regex', entityType: 'residence_permit',
    pattern: String.raw`(?<!\d)\d{18}(?!\d)`, contextKeywords: ['居住证'],
    maskMode: 'keepFirstLast', maskKeepFirst: 6, maskKeepLast: 4, priority: 285, severity: 'high' }),
  R({ code: 'org_code_cn', name: '组织机构代码', groupKey: 'identity_cn', kind: 'regex', entityType: 'org_code',
    pattern: String.raw`(?<![A-Za-z0-9])[A-Z0-9]{8}-[A-Z0-9](?![A-Za-z0-9])`,
    maskMode: 'keepLast', maskKeepLast: 4, priority: 286, severity: 'medium' }),

  /* ------------------------------ 国际证件 ------------------------------ */
  R({ code: 'us_ssn', name: '美国 SSN', groupKey: 'identity_intl', kind: 'regex', entityType: 'ssn',
    pattern: String.raw`(?<!\d)\d{3}-\d{2}-\d{4}(?!\d)`, validator: 'us_ssn',
    maskMode: 'keepLast', maskKeepLast: 4, priority: 300, region: 'US', severity: 'high' }),
  R({ code: 'us_itin', name: '美国 ITIN', groupKey: 'identity_intl', kind: 'regex', entityType: 'itin',
    pattern: String.raw`(?<!\d)9\d{2}-[78]\d-\d{4}(?!\d)`, validator: 'us_itin',
    maskMode: 'keepLast', maskKeepLast: 4, priority: 301, region: 'US', severity: 'high' }),
  R({ code: 'passport_intl', name: '国际护照号', groupKey: 'identity_intl', kind: 'regex', entityType: 'passport',
    pattern: String.raw`(?<![A-Za-z0-9])[A-Z]{1,2}\d{6,9}(?![A-Za-z0-9])`, contextKeywords: ['护照', 'passport'],
    maskMode: 'keepFirstLast', maskKeepFirst: 1, maskKeepLast: 3, priority: 310, severity: 'high' }),
  R({ code: 'eu_vat', name: '欧盟 VAT 号', groupKey: 'identity_intl', kind: 'regex', entityType: 'tax_id',
    pattern: String.raw`(?<![A-Za-z0-9])[A-Z]{2}\d{8,12}(?![A-Za-z0-9])`, contextKeywords: ['VAT', 'vat', '增值税'],
    maskMode: 'keepLast', maskKeepLast: 4, priority: 315, region: 'EU', severity: 'medium' }),
  R({ code: 'national_id_prompt', name: '其他国家证件/税号', groupKey: 'identity_intl', kind: 'prompt', entityType: 'national_id',
    instruction: '识别各国身份证、居留证、税号、护照等政府签发证件号码（非中国身份证）。',
    maskMode: 'keepFirstLast', maskKeepFirst: 2, maskKeepLast: 4, priority: 530, region: 'global', severity: 'high' }),

  /* ------------------------------ 金融支付 ------------------------------ */
  R({ code: 'bank_card', name: '银行卡号', groupKey: 'finance', kind: 'regex', entityType: 'bank_card',
    pattern: String.raw`(?<!\d)(\d{16,19})(?!\d)`, validator: 'luhn',
    maskMode: 'keepLast', maskKeepLast: 4, priority: 40, enabled: true, severity: 'high' }),
  R({ code: 'credit_card', name: '信用卡号', groupKey: 'finance', kind: 'regex', entityType: 'credit_card',
    pattern: String.raw`(?<!\d)(?:4\d{12}(?:\d{3})?|5[1-5]\d{14}|3[47]\d{13}|6(?:011|5\d{2})\d{12})(?!\d)`,
    validator: 'luhn', maskMode: 'keepLast', maskKeepLast: 4, priority: 330, severity: 'high' }),
  R({ code: 'cvv', name: 'CVV/CVC 安全码', groupKey: 'finance', kind: 'regex', entityType: 'cvv',
    pattern: String.raw`(?<!\d)\d{3,4}(?!\d)`, contextKeywords: ['CVV', 'CVC', '安全码', 'cvv'],
    maskMode: 'full', maskKeepFirst: 0, maskKeepLast: 0, priority: 340, severity: 'high' }),
  R({ code: 'iban', name: 'IBAN', groupKey: 'finance', kind: 'regex', entityType: 'iban',
    pattern: String.raw`(?<![A-Za-z0-9])[A-Z]{2}\d{2}[A-Z0-9]{11,30}(?![A-Za-z0-9])`, validator: 'iban',
    maskMode: 'keepLast', maskKeepLast: 4, priority: 350, severity: 'high' }),
  R({ code: 'swift_bic', name: 'SWIFT/BIC', groupKey: 'finance', kind: 'regex', entityType: 'swift',
    pattern: String.raw`(?<![A-Za-z0-9])[A-Z]{6}[A-Z0-9]{2}(?:[A-Z0-9]{3})?(?![A-Za-z0-9])`, contextKeywords: ['SWIFT', 'BIC'],
    maskMode: 'keepLast', maskKeepLast: 4, priority: 360, severity: 'medium' }),
  R({ code: 'bank_account_cn', name: '银行账号', groupKey: 'finance', kind: 'regex', entityType: 'bank_account',
    pattern: String.raw`(?<!\d)\d{16,19}(?!\d)`, contextKeywords: ['银行账号', '开户', '卡号'],
    maskMode: 'keepLast', maskKeepLast: 4, priority: 365, severity: 'high' }),
  R({ code: 'securities_account', name: '证券资金账号', groupKey: 'finance', kind: 'regex', entityType: 'securities_account',
    pattern: String.raw`(?<!\d)\d{10}(?!\d)`, contextKeywords: ['证券', '资金账户'],
    maskMode: 'keepLast', maskKeepLast: 4, priority: 370, severity: 'high' }),
  R({ code: 'fund_account', name: '基金账号', groupKey: 'finance', kind: 'regex', entityType: 'fund_account',
    pattern: String.raw`(?<!\d)\d{12}(?!\d)`, contextKeywords: ['基金账户', '基金账号'],
    maskMode: 'keepLast', maskKeepLast: 4, priority: 371, severity: 'high' }),
  R({ code: 'insurance_policy', name: '保单号', groupKey: 'finance', kind: 'regex', entityType: 'insurance_policy',
    pattern: String.raw`(?<![A-Za-z0-9])[A-Z]{1,3}\d{8,12}(?![A-Za-z0-9])`, contextKeywords: ['保单'],
    maskMode: 'keepLast', maskKeepLast: 4, priority: 372, severity: 'medium' }),
  R({ code: 'invoice_no', name: '发票号码', groupKey: 'finance', kind: 'regex', entityType: 'invoice',
    pattern: String.raw`(?<!\d)\d{8,20}(?!\d)`, contextKeywords: ['发票号码', '发票号'],
    maskMode: 'keepLast', maskKeepLast: 4, priority: 373, severity: 'medium' }),
  R({ code: 'tax_no_cn', name: '纳税人识别号', groupKey: 'finance', kind: 'regex', entityType: 'tax_id',
    pattern: String.raw`(?<![A-Za-z0-9])[A-Z0-9]{15,20}(?![A-Za-z0-9])`, contextKeywords: ['税号', '纳税人'],
    maskMode: 'keepLast', maskKeepLast: 4, priority: 374, severity: 'medium' }),

  /* ------------------------------ 医疗健康 ------------------------------ */
  R({ code: 'medical_record_no', name: '病历号/住院号', groupKey: 'healthcare', kind: 'regex', entityType: 'medical_record',
    pattern: String.raw`(?<![A-Za-z0-9])[A-Z]{0,2}\d{6,12}(?![A-Za-z0-9])`, contextKeywords: ['病历', '住院号'],
    maskMode: 'keepLast', maskKeepLast: 4, priority: 400, severity: 'high' }),
  R({ code: 'insurance_card_no', name: '医保卡号', groupKey: 'healthcare', kind: 'regex', entityType: 'insurance_card',
    pattern: String.raw`(?<!\d)\d{8,12}(?!\d)`, contextKeywords: ['医保卡'],
    maskMode: 'keepLast', maskKeepLast: 4, priority: 401, severity: 'high' }),
  R({ code: 'prescription_no', name: '处方号', groupKey: 'healthcare', kind: 'regex', entityType: 'prescription',
    pattern: String.raw`(?<![A-Za-z0-9])[A-Z]{0,2}\d{6,12}(?![A-Za-z0-9])`, contextKeywords: ['处方'],
    maskMode: 'keepLast', maskKeepLast: 4, priority: 402, severity: 'medium' }),
  R({ code: 'lab_report_no', name: '检验报告单号', groupKey: 'healthcare', kind: 'regex', entityType: 'lab_report',
    pattern: String.raw`(?<![A-Za-z0-9])[A-Z]{0,2}\d{6,12}(?![A-Za-z0-9])`, contextKeywords: ['检验报告', '报告单'],
    maskMode: 'keepLast', maskKeepLast: 4, priority: 403, severity: 'medium' }),
  R({ code: 'diagnosis', name: '诊断/病情', groupKey: 'healthcare', kind: 'prompt', entityType: 'diagnosis',
    instruction: '识别疾病名称、诊断结论、症状、病史等健康信息。',
    maskMode: 'full', maskKeepFirst: 0, maskKeepLast: 0, priority: 540, severity: 'high' }),
  R({ code: 'medication', name: '用药信息', groupKey: 'healthcare', kind: 'prompt', entityType: 'medication',
    instruction: '识别药品名称、剂量、用药方案、过敏药物等。',
    maskMode: 'keepFirstLast', maskKeepFirst: 1, maskKeepLast: 1, priority: 541, severity: 'high' }),
  R({ code: 'health_metric', name: '体检指标', groupKey: 'healthcare', kind: 'prompt', entityType: 'health_metric',
    instruction: '识别血压、血糖、血脂、BMI、检验指标等健康测量值。',
    maskMode: 'full', maskKeepFirst: 0, maskKeepLast: 0, priority: 542, severity: 'high' }),
  R({ code: 'genetic', name: '基因信息', groupKey: 'healthcare', kind: 'prompt', entityType: 'genetic',
    instruction: '识别基因位点、遗传病、基因检测结果等基因信息。',
    maskMode: 'full', maskKeepFirst: 0, maskKeepLast: 0, priority: 543, severity: 'high' }),

  /* ------------------------------ 人力资源 ------------------------------ */
  R({ code: 'employee_id', name: '工号', groupKey: 'hr', kind: 'regex', entityType: 'employee_id',
    pattern: String.raw`(?<![A-Za-z0-9])(?:EMP|E)[-_]?\d{4,10}(?![A-Za-z0-9])`, flags: 'gi',
    maskMode: 'keepLast', maskKeepLast: 3, priority: 420, severity: 'medium' }),
  R({ code: 'salary', name: '薪资/薪酬', groupKey: 'hr', kind: 'prompt', entityType: 'salary',
    instruction: '识别工资、月薪、年薪、奖金、期权、社保公积金缴纳基数等薪酬信息。',
    maskMode: 'keepLast', maskKeepLast: 2, priority: 550, severity: 'high' }),
  R({ code: 'performance', name: '绩效/考核', groupKey: 'hr', kind: 'prompt', entityType: 'performance',
    instruction: '识别绩效评分、考核结果、晋升/淘汰结论、员工评价等。',
    maskMode: 'full', maskKeepFirst: 0, maskKeepLast: 0, priority: 551, severity: 'high' }),

  /* ------------------------------ 电商零售 ------------------------------ */
  R({ code: 'order_no', name: '订单号', groupKey: 'ecommerce', kind: 'regex', entityType: 'order_no',
    pattern: String.raw`(?<![A-Za-z0-9])\d{12,20}(?![A-Za-z0-9])`, contextKeywords: ['订单', 'order'],
    maskMode: 'keepLast', maskKeepLast: 4, priority: 440, severity: 'medium' }),
  R({ code: 'tracking_no', name: '快递/运单号', groupKey: 'ecommerce', kind: 'regex', entityType: 'tracking_no',
    pattern: String.raw`(?<![A-Za-z0-9])[A-Z]{2}\d{9,13}(?![A-Za-z0-9])`, contextKeywords: ['快递', '运单', '物流'],
    maskMode: 'keepLast', maskKeepLast: 4, priority: 441, severity: 'medium' }),
  R({ code: 'recipient', name: '收件人信息', groupKey: 'ecommerce', kind: 'prompt', entityType: 'recipient',
    instruction: '识别收件人/收货人姓名、电话、地址组合等物流面单信息。',
    maskMode: 'keepFirstLast', maskKeepFirst: 1, maskKeepLast: 1, priority: 560, severity: 'high' }),

  /* ------------------------------ 网络与设备 ------------------------------ */
  R({ code: 'ipv4', name: 'IPv4 地址', groupKey: 'internet', kind: 'regex', entityType: 'ip',
    pattern: String.raw`(?<!\d)(?:\d{1,3}\.){3}\d{1,3}(?!\d)`, validator: 'ipv4',
    maskMode: 'keepFirstLast', maskKeepFirst: 3, maskKeepLast: 2, priority: 460, severity: 'medium' }),
  R({ code: 'ipv6', name: 'IPv6 地址', groupKey: 'internet', kind: 'regex', entityType: 'ip',
    pattern: String.raw`(?<![0-9A-Fa-f:])(?:[0-9A-Fa-f]{1,4}:){2,7}[0-9A-Fa-f]{1,4}(?![0-9A-Fa-f:])`, validator: 'ipv6',
    maskMode: 'keepFirstLast', maskKeepFirst: 4, maskKeepLast: 4, priority: 461, severity: 'medium' }),
  R({ code: 'mac', name: 'MAC 地址', groupKey: 'internet', kind: 'regex', entityType: 'mac',
    pattern: String.raw`(?<![0-9A-Fa-f])(?:[0-9A-Fa-f]{2}[:-]){5}[0-9A-Fa-f]{2}(?![0-9A-Fa-f])`, validator: 'mac',
    maskMode: 'keepFirstLast', maskKeepFirst: 6, maskKeepLast: 5, priority: 462, severity: 'medium' }),
  R({ code: 'android_id', name: 'Android ID', groupKey: 'internet', kind: 'regex', entityType: 'device_id',
    pattern: String.raw`(?<![0-9A-f])[0-9a-f]{16}(?![0-9a-f])`, contextKeywords: ['Android ID', 'android_id'],
    maskMode: 'keepLast', maskKeepLast: 4, priority: 466, severity: 'medium' }),
  R({ code: 'advertising_id', name: '广告标识（IDFA/GAID）', groupKey: 'internet', kind: 'regex', entityType: 'advertising_id',
    pattern: String.raw`(?<![0-9a-fA-F])[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}(?![0-9a-fA-F])`,
    validator: 'uuid', contextKeywords: ['IDFA', 'GAID', '广告标识', '设备标识'],
    maskMode: 'keepLast', maskKeepLast: 4, priority: 467, severity: 'medium' }),

  /* ------------------------------ 账号凭据 ------------------------------ */
  R({ code: 'credential', name: '账号/密码', groupKey: 'credentials', kind: 'prompt', entityType: 'credential',
    instruction: '识别账号、密码、API Key、Token、验证码、密钥等凭据。',
    maskMode: 'full', maskKeepFirst: 0, maskKeepLast: 0, priority: 570, severity: 'high' }),
  R({ code: 'api_key', name: 'API Key', groupKey: 'credentials', kind: 'regex', entityType: 'api_key',
    pattern: String.raw`(?<![A-Za-z0-9])(?:sk-[A-Za-z0-9]{20,}|AKIA[0-9A-Z]{16}|ghp_[A-Za-z0-9]{36}|xox[baprs]-[A-Za-z0-9-]{10,})(?![A-Za-z0-9])`,
    maskMode: 'full', maskKeepFirst: 0, maskKeepLast: 0, priority: 480, severity: 'high' }),
  R({ code: 'jwt', name: 'JWT', groupKey: 'credentials', kind: 'regex', entityType: 'jwt',
    pattern: String.raw`(?<![A-Za-z0-9_-])eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}(?![A-Za-z0-9_-])`,
    validator: 'jwt', maskMode: 'full', maskKeepFirst: 0, maskKeepLast: 0, priority: 481, severity: 'high' }),
  R({ code: 'private_key', name: '私钥（PEM）', groupKey: 'credentials', kind: 'regex', entityType: 'private_key',
    pattern: String.raw`-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----[\s\S]+?-----END (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----`,
    maskMode: 'full', maskKeepFirst: 0, maskKeepLast: 0, priority: 482, severity: 'high' }),
  R({ code: 'bearer_token', name: 'Bearer Token', groupKey: 'credentials', kind: 'regex', entityType: 'token',
    pattern: String.raw`\bBearer\s+[A-Za-z0-9._~+/=-]{10,}`, flags: 'gi',
    maskMode: 'full', maskKeepFirst: 0, maskKeepLast: 0, priority: 483, severity: 'high' }),
  R({ code: 'database_url', name: '数据库/连接串', groupKey: 'credentials', kind: 'regex', entityType: 'connection_string',
    pattern: String.raw`(?<![A-Za-z0-9])(?:postgres|postgresql|mysql|mongodb|redis|amqp):\/\/[^\s:@/]+:[^\s@/]+@[^\s]+`,
    flags: 'gi', maskMode: 'full', maskKeepFirst: 0, maskKeepLast: 0, priority: 484, severity: 'high' }),
  R({ code: 'otp', name: '验证码/OTP', groupKey: 'credentials', kind: 'regex', entityType: 'otp',
    pattern: String.raw`(?<!\d)\d{4,8}(?!\d)`, contextKeywords: ['验证码', 'OTP', '一次性'],
    maskMode: 'full', maskKeepFirst: 0, maskKeepLast: 0, priority: 485, severity: 'high' }),

  /* -------------------------------- 教育 -------------------------------- */
  R({ code: 'student_id', name: '学号', groupKey: 'education', kind: 'regex', entityType: 'student_id',
    pattern: String.raw`(?<![A-Za-z0-9])\d{6,12}(?![A-Za-z0-9])`, contextKeywords: ['学号'],
    maskMode: 'keepLast', maskKeepLast: 4, priority: 500, severity: 'medium' }),
  R({ code: 'exam_no', name: '准考证号', groupKey: 'education', kind: 'regex', entityType: 'exam_no',
    pattern: String.raw`(?<![A-Za-z0-9])\d{8,15}(?![A-Za-z0-9])`, contextKeywords: ['准考证'],
    maskMode: 'keepLast', maskKeepLast: 4, priority: 501, severity: 'medium' }),
  R({ code: 'score', name: '成绩/排名', groupKey: 'education', kind: 'prompt', entityType: 'score',
    instruction: '识别考试分数、排名、录取结果、评语等教育结果信息。',
    maskMode: 'keepLast', maskKeepLast: 2, priority: 580, severity: 'medium' }),

  /* ------------------------------ 法律政务 ------------------------------ */
  R({ code: 'case_no', name: '案号', groupKey: 'legal', kind: 'regex', entityType: 'case_no',
    pattern: String.raw`(?<![A-Za-z0-9])[（(]\d{4}[）)]\d{1,4}[\u4e00-\u9fa5]{1,6}\d{1,6}号(?![A-Za-z0-9])`,
    maskMode: 'keepLast', maskKeepLast: 4, priority: 520, severity: 'high' }),
  R({ code: 'contract_no', name: '合同编号', groupKey: 'legal', kind: 'regex', entityType: 'contract_no',
    pattern: String.raw`(?<![A-Za-z0-9])[A-Z]{2,4}[-_]?\d{6,12}(?![A-Za-z0-9])`, contextKeywords: ['合同'],
    maskMode: 'keepLast', maskKeepLast: 4, priority: 521, severity: 'medium' }),
  R({ code: 'lawyer_license', name: '律师执业证号', groupKey: 'legal', kind: 'regex', entityType: 'lawyer_license',
    pattern: String.raw`(?<!\d)\d{17}(?![A-Za-z0-9])`, contextKeywords: ['律师执业证', '律师证'],
    maskMode: 'keepLast', maskKeepLast: 4, priority: 522, severity: 'high' }),
  R({ code: 'unified_social_credit', name: '统一社会信用代码', groupKey: 'legal', kind: 'regex', entityType: 'uscc',
    pattern: String.raw`(?<![A-Za-z0-9])[0-9A-HJ-NPQRTUWXY]{2}\d{6}[0-9A-HJ-NPQRTUWXY]{10}(?![A-Za-z0-9])`,
    validator: 'uscc', maskMode: 'keepLast', maskKeepLast: 4, priority: 523, severity: 'medium' }),
  R({ code: 'court_doc', name: '法律文书内容', groupKey: 'legal', kind: 'prompt', entityType: 'legal_doc',
    instruction: '识别判决书/起诉状中的当事人、案由、证据、判决结果等敏感法律内容。',
    maskMode: 'keepFirstLast', maskKeepFirst: 2, maskKeepLast: 2, priority: 581, severity: 'high' }),

  /* ------------------------------ 汽车交通 ------------------------------ */
  R({ code: 'license_plate_cn', name: '中国车牌号', groupKey: 'automotive', kind: 'regex', entityType: 'license_plate',
    pattern: String.raw`(?<![A-Za-z0-9\u4e00-\u9fa5])[\u4e00-\u9fa5][A-HJ-NP-Z][A-HJ-NP-Z0-9]{4,5}[A-HJ-NP-Z0-9\u4e00-\u9fa5](?![A-Za-z0-9\u4e00-\u9fa5])`,
    maskMode: 'keepFirstLast', maskKeepFirst: 2, maskKeepLast: 2, priority: 540, severity: 'high' }),
  R({ code: 'vin', name: '车架号 VIN', groupKey: 'automotive', kind: 'regex', entityType: 'vin',
    pattern: String.raw`(?<![A-Za-z0-9])[A-HJ-NPR-Z0-9]{17}(?![A-Za-z0-9])`, validator: 'vin',
    maskMode: 'keepLast', maskKeepLast: 4, priority: 541, severity: 'high' }),
  R({ code: 'engine_no', name: '发动机号', groupKey: 'automotive', kind: 'regex', entityType: 'engine_no',
    pattern: String.raw`(?<![A-Za-z0-9])[A-Z0-9]{6,17}(?![A-Za-z0-9])`, contextKeywords: ['发动机号', '发动机'],
    maskMode: 'keepLast', maskKeepLast: 4, priority: 542, severity: 'medium' }),

  /* ------------------------------ 位置信息 ------------------------------ */
  R({ code: 'coordinates', name: '经纬度坐标', groupKey: 'location', kind: 'regex', entityType: 'coordinates',
    pattern: String.raw`(?<!\d)(-?\d{1,3}\.\d{3,})\s*[,，]\s*(-?\d{1,3}\.\d{3,})(?!\d)`, validator: 'coordinates',
    maskMode: 'keepLast', maskKeepLast: 4, priority: 560, severity: 'high' }),
  R({ code: 'geohash', name: 'Geohash', groupKey: 'location', kind: 'regex', entityType: 'geohash',
    pattern: String.raw`(?<![A-Za-z0-9])[0-9bcdefghjkmnpqrstuvwxyz]{6,12}(?![A-Za-z0-9])`, contextKeywords: ['geohash', '坐标'],
    maskMode: 'keepLast', maskKeepLast: 3, priority: 561, severity: 'medium' }),

  /* ------------------------------ 生物特征 ------------------------------ */
  R({ code: 'biometric', name: '生物特征', groupKey: 'biometric', kind: 'prompt', entityType: 'biometric',
    instruction: '识别指纹、人脸、虹膜、声纹、掌纹、DNA 等生物特征信息。',
    maskMode: 'full', maskKeepFirst: 0, maskKeepLast: 0, priority: 590, severity: 'high' }),

  /* ------------------------------- 区块链 ------------------------------- */
  R({ code: 'eth_address', name: 'ETH 地址', groupKey: 'crypto', kind: 'regex', entityType: 'wallet',
    pattern: String.raw`(?<![0-9A-Fa-f])0x[0-9A-Fa-f]{40}(?![0-9A-Fa-f])`, validator: 'eth',
    maskMode: 'keepFirstLast', maskKeepFirst: 4, maskKeepLast: 4, priority: 580, severity: 'medium' }),
  R({ code: 'btc_address', name: 'BTC 地址', groupKey: 'crypto', kind: 'regex', entityType: 'wallet',
    pattern: String.raw`(?<![A-Za-z0-9])[13][a-km-zA-HJ-NP-Z1-9]{25,34}(?![A-Za-z0-9])`, validator: 'btc',
    maskMode: 'keepFirstLast', maskKeepFirst: 4, maskKeepLast: 4, priority: 581, severity: 'medium' }),
  R({ code: 'crypto_private_key', name: '区块链私钥', groupKey: 'crypto', kind: 'regex', entityType: 'private_key',
    pattern: String.raw`(?<![0-9A-Fa-f])[0-9A-Fa-f]{64}(?![0-9A-Fa-f])`, contextKeywords: ['私钥', 'private key'],
    maskMode: 'full', maskKeepFirst: 0, maskKeepLast: 0, priority: 582, severity: 'high' }),
  R({ code: 'mnemonic', name: '助记词', groupKey: 'crypto', kind: 'prompt', entityType: 'mnemonic',
    instruction: '识别 12/24 个英文单词组成的钱包助记词（seed phrase）。',
    maskMode: 'full', maskKeepFirst: 0, maskKeepLast: 0, priority: 591, severity: 'high' }),

  /* -------------------------------- 通信 -------------------------------- */
  R({ code: 'imei', name: 'IMEI', groupKey: 'telecom', kind: 'regex', entityType: 'imei',
    pattern: String.raw`(?<!\d)\d{15}(?!\d)`, validator: 'luhn',
    maskMode: 'keepFirstLast', maskKeepFirst: 4, maskKeepLast: 4, priority: 463, severity: 'medium' }),
  R({ code: 'imsi', name: 'IMSI', groupKey: 'telecom', kind: 'regex', entityType: 'imsi',
    pattern: String.raw`(?<!\d)\d{15}(?!\d)`, contextKeywords: ['IMSI'],
    maskMode: 'keepFirstLast', maskKeepFirst: 4, maskKeepLast: 4, priority: 464, severity: 'medium' }),
  R({ code: 'iccid', name: 'ICCID（SIM 卡号）', groupKey: 'telecom', kind: 'regex', entityType: 'iccid',
    pattern: String.raw`(?<!\d)\d{19,20}(?!\d)`, contextKeywords: ['ICCID'],
    maskMode: 'keepFirstLast', maskKeepFirst: 4, maskKeepLast: 4, priority: 465, severity: 'medium' }),

  /* -------------------------------- 房产 -------------------------------- */
  R({ code: 'property_cert_no', name: '房产证/不动产权证号', groupKey: 'realestate', kind: 'regex', entityType: 'property_cert',
    pattern: String.raw`(?<![A-Za-z0-9])[A-Za-z0-9]{6,20}(?![A-Za-z0-9])`, contextKeywords: ['房产证', '不动产权'],
    maskMode: 'keepLast', maskKeepLast: 4, priority: 620, severity: 'high' }),
  R({ code: 'property_owner', name: '产权人信息', groupKey: 'realestate', kind: 'prompt', entityType: 'property_owner',
    instruction: '识别房产证/购房合同中的产权人姓名、证件号、共有情况、房产地址。',
    maskMode: 'keepFirstLast', maskKeepFirst: 1, maskKeepLast: 1, priority: 621, severity: 'high' }),
];

export const PRIVACY_CATALOG_BY_CODE = new Map(PRIVACY_CATALOG.map((rule) => [rule.code, rule]));
