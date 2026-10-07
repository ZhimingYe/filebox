import { defineConfig } from 'vitepress'

// Bilingual docs: Chinese (default `/`) + English (`/en/`).
// Published to GitHub Pages at /filebox/docs/ alongside the interactive demo.
const zhNav = [
  { text: '指南', link: '/guide/introduction' },
  { text: '功能', link: '/features/browse' },
  { text: '运维', link: '/ops/hub' },
  { text: '在线演示', link: 'https://zhimingye.github.io/filebox/' },
  { text: 'GitHub', link: 'https://github.com/ZhimingYe/filebox' },
]

const enNav = [
  { text: 'Guide', link: '/en/guide/introduction' },
  { text: 'Features', link: '/en/features/browse' },
  { text: 'Ops', link: '/en/ops/hub' },
  { text: 'Live demo', link: 'https://zhimingye.github.io/filebox/' },
  { text: 'GitHub', link: 'https://github.com/ZhimingYe/filebox' },
]

const zhSidebar = {
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
}

const enSidebar = {
  '/en/guide/': [
    {
      text: 'Getting started',
      items: [
        { text: 'What is filebox', link: '/en/guide/introduction' },
        { text: 'Quick start', link: '/en/guide/quick-start' },
        { text: 'Install Hub', link: '/en/guide/install-hub' },
        { text: 'Install Agent', link: '/en/guide/install-agent' },
        { text: 'First login & add roots', link: '/en/guide/first-login' },
      ],
    },
  ],
  '/en/features/': [
    {
      text: 'How to use',
      items: [
        { text: 'Browse files', link: '/en/features/browse' },
        { text: 'Explorer tree', link: '/en/features/explorer' },
        { text: 'Preview (image / PDF / code / tables)', link: '/en/features/preview' },
        { text: 'Workspace search', link: '/en/features/search' },
        { text: 'Collections', link: '/en/features/collections' },
        { text: 'Transfer', link: '/en/features/transfer' },
        { text: 'Terminal', link: '/en/features/terminal' },
        { text: 'System monitor', link: '/en/features/stats' },
        { text: 'Security & sensitive files', link: '/en/features/security' },
      ],
    },
  ],
  '/en/ops/': [
    {
      text: 'Ops & advanced',
      items: [
        { text: 'Hub config & HTTPS', link: '/en/ops/hub' },
        { text: 'Agent config & updates', link: '/en/ops/agent' },
        { text: 'Office preview (LibreOffice)', link: '/en/ops/office' },
        { text: 'FAQ', link: '/en/ops/faq' },
      ],
    },
  ],
}

export default defineConfig({
  title: 'filebox',
  description:
    'Lab / HPC read-only remote file browser — Hub + Agent, no public IP / inbound ports / VPN',
  base: '/filebox/docs/',
  cleanUrls: true,
  lastUpdated: true,
  ignoreDeadLinks: false,
  head: [
    ['link', { rel: 'icon', href: '/filebox/docs/favicon.svg', type: 'image/svg+xml' }],
    ['meta', { name: 'theme-color', content: '#6366f1' }],
  ],
  locales: {
    root: {
      label: '中文',
      lang: 'zh-CN',
      title: 'filebox 文档',
      description:
        '实验室 / HPC 只读远程文件浏览器 — 安装 Hub 与 Agent，浏览、搜索、合集、传输、终端与系统监控',
      head: [
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
        nav: zhNav,
        sidebar: zhSidebar,
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
        search: {
          provider: 'local',
          options: {
            locales: {
              root: {
                translations: {
                  button: { buttonText: '搜索', buttonAriaLabel: '搜索文档' },
                  modal: {
                    displayDetails: '显示详细列表',
                    resetButtonTitle: '清除查询',
                    backButtonTitle: '关闭搜索',
                    noResultsText: '没有结果',
                    footer: {
                      selectText: '选择',
                      navigateText: '切换',
                      closeText: '关闭',
                    },
                  },
                },
              },
            },
          },
        },
        outline: { label: '本页目录', level: [2, 3] },
        docFooter: { prev: '上一页', next: '下一页' },
        lastUpdated: { text: '最后更新' },
        darkModeSwitchLabel: '主题',
        lightModeSwitchTitle: '切换到浅色',
        darkModeSwitchTitle: '切换到深色',
        returnToTopLabel: '回到顶部',
        sidebarMenuLabel: '菜单',
        langMenuLabel: '语言',
      },
    },
    en: {
      label: 'English',
      lang: 'en-US',
      link: '/en/',
      title: 'filebox Docs',
      description:
        'Lab / HPC read-only remote file browser — install Hub & Agent; browse, search, collections, transfer, terminal, and system monitor',
      head: [
        ['meta', { property: 'og:title', content: 'filebox Docs' }],
        [
          'meta',
          {
            property: 'og:description',
            content:
              'See server results from any browser — Hub + Agent, no public IP / inbound ports / VPN',
          },
        ],
      ],
      themeConfig: {
        logo: { src: '/favicon.svg', alt: 'filebox' },
        siteTitle: 'filebox',
        nav: enNav,
        sidebar: enSidebar,
        socialLinks: [{ icon: 'github', link: 'https://github.com/ZhimingYe/filebox' }],
        editLink: {
          pattern: 'https://github.com/ZhimingYe/filebox/edit/main/website/docs/:path',
          text: 'Edit this page on GitHub',
        },
        footer: {
          message:
            'MIT Licensed · <a href="https://zhimingye.github.io/filebox/">Live demo</a> · <a href="https://github.com/ZhimingYe/filebox/releases/latest">Download release</a>',
          copyright: 'Copyright © filebox contributors',
        },
        search: { provider: 'local' },
        outline: { label: 'On this page', level: [2, 3] },
        docFooter: { prev: 'Previous', next: 'Next' },
        lastUpdated: { text: 'Last updated' },
        darkModeSwitchLabel: 'Theme',
        lightModeSwitchTitle: 'Switch to light',
        darkModeSwitchTitle: 'Switch to dark',
        returnToTopLabel: 'Return to top',
        sidebarMenuLabel: 'Menu',
        langMenuLabel: 'Language',
      },
    },
  },
})
