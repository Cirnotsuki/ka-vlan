# SignPath 免费开源签名接入指南

## 前置条件

1. 项目在 GitHub 上公开（公开仓库 + 开源许可证，建议 MIT）；
2. 有 GitHub 账号与组织/个人主页；
3. 注册 SignPath 账号：<https://signpath.io>。

## 申请流程

1. 到 <https://signpath.org/foundation> 填表申请「开源签名证书」（免费）：
   - 填项目名、GitHub 仓库地址、开源许可证（MIT）、联系人；
   - 审核一般 1~5 个工作日，通过后邮件发放 **Organization ID** 与说明。
2. 登录 signpath.io → 创建/绑定 Organization → 新建 Project（slug 记下来，如 `vlan-app`）；
3. 在 Project → Signing Policies 里会有 **test-policy / CI（release）policy**（Foundation 证书的政策，GUID 记下来）；
4. Users → API Token：生成一个带签名权限的 token（只放 CI 使用，别提交进仓库）。

## 与打包管线对接

签名策略要求**签名请求来自 CI 构建**（Foundation 政策的核心要求：可复现的公开构建），
所以推荐 GitHub Actions 发布流程；本地打包（`npm run pack`）不做签名，仅供开发/内测。

### GitHub Actions 示例（.github/workflows/release.yml 关键段）

```yaml
- name: Build
  run: npm install && npm run pack        # 产物在 dist/ka-vlan/win-unpacked

- name: Sign binaries (SignPath)
  env:
    SIGNPATH_API_TOKEN: ${{ secrets.SIGNPATH_API_TOKEN }}
    SIGNPATH_ORGANIZATION_ID: ${{ secrets.SIGNPATH_ORGANIZATION_ID }}
    SIGNPATH_PROJECT_SLUG: ${{ secrets.SIGNPATH_PROJECT_SLUG }}
    SIGNPATH_SIGNING_POLICY: ${{ secrets.SIGNPATH_SIGNING_POLICY }}   # release 政策 GUID
  run: powershell -File scripts/signpath-sign.ps1 `
        -Files "dist/ka-vlan/win-unpacked/KA VLAN.exe","dist/ka-vlan/win-unpacked/resources/core/vlancore.exe"
```

- secrets 在仓库 Settings → Secrets 里配置（token 千万别明文进仓库）；
- 签名后的文件由 SignPath 返回并原地覆盖。

## 本地（可选）签名

有 token 时本地也能发起签名请求（Foundation 政策可能会拒绝非 CI 来源，被拒就走上面的 Actions 流程）：

```powershell
$env:SIGNPATH_API_TOKEN='...'; $env:SIGNPATH_ORGANIZATION_ID='...';
$env:SIGNPATH_PROJECT_SLUG='vlan-app'; $env:SIGNPATH_SIGNING_POLICY='...';
powershell -File scripts/signpath-sign.ps1 -Files "dist/ka-vlan/win-unpacked/KA VLAN.exe"
```

## 效果

- `KA VLAN.exe` / `vlancore.exe` 获得**全球信任的 Authenticode 签名**；
- 用户机器上的 360/Defender/SmartScreen 不再按"未知程序"拦截（360 对已认证签名软件还有开发者认证通道：open.360.cn，可选叠加）；
- 签名状态可用 `Get-AuthenticodeSignature <exe>` 自查（Valid 即通过）。

## 注意

- 签名会改变文件 hash → 发布包要在签名**之后**打 zip/安装包；
- 不要把 API Token 写进任何提交内容；
- 私钥由 SignPath 云托管，符合当前 CA/B Forum 对代码签名私钥的硬件要求，无需自己买 USB Key。
