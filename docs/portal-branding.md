# Mirror V Portal 品牌与兼容边界

门户产品名称为 **Mirror V Portal**，代码仓库为 `vegekyd-sys/mirror-v-portal`。它是 Mirror V 的多 Agent 入口，当前提供 Mirror V 与 DealClaw 模板。V 原有的 DealClaw 专属 **Nexus** 项目继续独立运营，不属于本仓库的改名范围。

用户可见的门户页、管理后台、标题与新文档使用 Mirror V Portal。以下 `nexus` 标识是存量运行接口，暂时保留，以免改名导致现有实例、服务或数据失联：

- 腾讯云的 `/opt/nexus` 数据与 release 目录、`nexus-*` systemd 服务、Nginx 配置文件。
- 数据库 `nexus_elastic`、环境变量 `NEXUS_*`、网关协议事件 `nexus.*`、历史 package 路径与 Kubernetes 资源名。
- 背景视频和图片的静态文件名；它们只是资源路径，不代表产品名称。

未来迁移这些内部标识时，应单独设计双读或别名期与回滚方式，不与品牌发布混在一起。
