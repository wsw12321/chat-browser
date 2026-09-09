# 文件审查合成样本

所有样本均为本仓库生成的小型无敏感测试资料，无账号、用户文件或真实网络目标。不要使用系统 PDF/Office 查看器测试主动动作样本；通过本站受限解析入口检查。

| 文件                     | 预期结果                                              |
| ------------------------ | ----------------------------------------------------- |
| `utf8.txt`               | 严格 UTF-8 解码、统一换行、文字可发送                 |
| `quoted.csv`             | 保留引号内逗号/换行及公式文字，不计算公式             |
| `ordinary.pdf`           | 提取文字后等待确认 PDF 文字模式                       |
| `open-action-launch.pdf` | `active_content_not_allowed`，不执行动作              |
| `needs-ocr.pdf`          | `document_requires_ocr`                               |
| `simple.docx`            | 提取普通段落和简单表格                                |
| `unsafe-dtd.docx`        | `active_content_not_allowed`，即使 DTD 位于非正文部件 |

更多边界样本由 `packages/file-review/test/fixture-builders.ts` 在测试期间生成，包含有效交叉引用、40/41 页、各种 OpenAction/Next/AA/批注、结构树关联附件，以及 ZIP 头部、CRC 和 XML 复杂度异常。图片边界样本在 `images.test.ts` 中按声明尺寸生成；像素炸弹仅进入头部检查，不实际解码。资源测试使用小阈值，不在 CI 耗尽宿主内存。

这些样本覆盖实现拒绝规则，不代替正式浏览器设备、真实容量、真实模型和真实取消链路验收。
