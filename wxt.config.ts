import { defineConfig } from 'wxt';

export default defineConfig({
  srcDir: 'src',
  manifest: {
    name: 'DESIGN.md Extractor',
    description: '一键提取网页视觉风格，生成符合 Google DESIGN.md 规范的设计系统文件',
    version: '0.1.0',
    /**
     * 侧边栏靠 sidePanel.open() 打开，这个接口 Chrome 116 才有。
     *
     * 写这一行的作用是让版本不够的浏览器直接装不上，而不是装上一个点图标
     * 什么都不会发生的扩展。侧边栏本身 114 就有，但「点图标就打开」要的那
     * 一句是 116 才补上的。
     */
    minimum_chrome_version: '116',
    permissions: ['activeTab', 'scripting', 'storage'],
    /**
     * 本地文件单独声明，和下面那组按需申请的权限分开。
     *
     * 原因是 file 模式不能按需申请。Chrome 对本地文件的读法只有一条路，
     * 就是扩展详情页上那个「允许访问文件网址」开关，而且这个开关
     * **只有 manifest 里声明了 file 模式才会出现**——打包安装的扩展
     * 如果不声明，详情页上连开关都没有，用户想开也开不了。所以这一条
     * 必须写死在必需权限里，不能挪到下面那一行。
     *
     * 代价是零。Chrome 的安装警告只针对 http 与 https 的匹配模式，
     * file 模式不在警告列表里，装的时候不会多出任何提示；而且声明归声明，
     * 真正能读本地文件仍然要先由用户把那个开关拨开，动作在用户手上。
     *
     * activeTab 覆盖不到 file 地址，所以这一条是必需的，不是保险。
     */
    host_permissions: ['file:///*'],
    /**
     * 模型接口的权限按需申请，不在这里写死。
     *
     * 写死成 host_permissions 的话，安装提示里会出现「读取你在所有网站上的
     * 数据」，而绝大多数用户只会用到其中一家的一个域名。改成可选之后，扩展
     * 只在用户填了哪个地址时才去申请哪个域名，安装时那一行不会出现。
     *
     * 代价是首次保存配置会弹一次授权确认。这一步由设置页在用户点击时触发，
     * 属于能解释清楚的时刻。
     *
     * http:// 这一段是留给本地部署的（Ollama、LM Studio 之类），它们的地址
     * 就是明文 http。去掉这一段会让本地部署整条路走不通。
     */
    optional_host_permissions: ['https://*/*', 'http://*/*'],
    action: {
      default_title: '提取当前页面风格',
    },
    /**
     * 设置页在新标签里打开，而不是默认的嵌入式对话框。
     *
     * 这一项不在 manifest 里配。WXT 会把 options 入口自己的默认值写进
     * options_ui，这里写的会被它盖掉；正确的位置是那个 HTML 文件里的
     * manifest.open_in_tab meta 标签，见 src/entrypoints/options/index.html。
     */
  },
});
