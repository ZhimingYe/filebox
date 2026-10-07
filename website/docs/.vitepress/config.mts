import { defineConfig } from 'vitepress'

// User-facing docs (Chinese). Developer runbooks stay in repo-root docs/.
// Built site is published to GitHub Pages at /filebox/docs/ alongside the
// interactive demo at /filebox/.
export default defineConfig({
  title: 'filebox 文档',
  description:
    '实验室 / HPC 只读远程文件浏览器 — 安装 Hub 与 Agent，浏览、搜索、合集、传输、终端与系统监控',
  lang: 'zh-CN',
  base: '/filebox/docs/',
  cleanUrls: true,
  lastUpdated: true,
  ignoreDeadLinks: false,
  head: [
    ['link', { rel: 'icon', href: '/filebox/docs/favicon.svg', type: 'image/svg+xml' }],
    ['meta', { name: 'theme-color', content: '#6366f1' }],
    ['meta', { property: 'og:title', content: 'filebox 文档' }],
    [
      'meta',
      {
        property: 'og:description',
        content: '从任意浏览器看服务器上的结果 — Hub + Agent，无需公网 IP / 入站端口 / VPN',
      },
    ],
  ],
  themeConfig: {
    logo: { src: '/favicon.svg', alt: 'filebox' },
    siteTitle: 'filebox',
    nav: [
      { text: '指南', link: '/guide/introduction' },
      { text: '功能', link: '/features/browse' },
      { text: '运维', link: '/ops/hub' },
      { text: '在线演示', link: 'https://zhimingye.github.io/filebox/' },
      { text: 'GitHub', link: 'https://github.com/ZhimingYe/filebox' },
    ],
    sidebar: {
      '/guide/': [
        {
          text: '开始使用',
          items: [
            { text: '什么是 filebox', link: '/guide/introduction' },
            { text: '快速开始', link: '/guide/quick-start' },
            { text: '部署 Hub', link: '/guide/install-hub' },
            { text: '部署 Agent', link: '/guide/install-agent' },
            { text: '首次登录与添加目录', link: '/guide/first-login' },
          ],
        },
      ],
      '/features/': [
        {
          text: '怎么用',
          items: [
            { text: '浏览文件', link: '/features/browse' },
            { text: 'Explorer 树形视图', link: '/features/explorer' },
            { text: '预览（图 / PDF / 代码 / 表格）', link: '/features/preview' },
            { text: '工作区搜索', link: '/features/search' },
            { text: '合集 Collections', link: '/features/collections' },
            { text: '临时传输 Transfer', link: '/features/transfer' },
            { text: '远程终端 Terminal', link: '/features/terminal' },
            { text: '系统监控', link: '/features/stats' },
            { text: '安全与敏感文件', link: '/features/security' },
          ],
        },
      ],
      '/ops/': [
        {
          text: '运维与进阶',
          items: [
            { text: 'Hub 配置与 HTTPS', link: '/ops/hub' },
            { text: 'Agent 配置与更新', link: '/ops/agent' },
            { text: 'Office 预览（LibreOffice）', link: '/ops/office' },
            { text: '常见问题', link: '/ops/faq' },
          ],
        },
      ],
    },
    socialLinks: [{ icon: 'github', link: 'https://github.com/ZhimingYe/filebox' }],
    editLink: {
      pattern: 'https://github.com/ZhimingYe/filebox/edit/main/website/docs/:path',
      text: '在 GitHub 上编辑此页',
    },
    footer: {
      message:
        'MIT Licensed · <a href="https://zhimingye.github.io/filebox/">在线演示</a> · <a href="https://github.com/ZhimingYe/filebox/releases/latest">下载 Release</a>',
      copyright: 'Copyright © filebox contributors',
    },
    search: { provider: 'local' },
    outline: { label: '本页目录', level: [2, 3] },
    docFooter: { prev: '上一页', next: '下一页' },
    lastUpdated: { text: '最后更新' },
    darkModeSwitchLabel: '主题',
    lightModeSwitchTitle: '切换到浅色',
    darkModeSwitchTitle: '切换到深色',
    returnToTopLabel: '回到顶部',
    sidebarMenuLabel: '菜单',
  },
})
