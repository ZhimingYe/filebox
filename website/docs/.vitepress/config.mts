import { defineConfig } from 'vitepress'

// Bilingual docs: English (default, `/`) + Chinese (`/zh/`).
// Published to GitHub Pages at the site root: https://zhimingye.github.io/filebox/
// Legacy URLs (/filebox/en/..., /filebox/docs/..., /filebox/docs/en/...) redirect
// via stubs on the gh-pages branch (scripts/gen-legacy-redirects.mjs) plus the
// 404 fallback script below.
const LEGACY_REDIRECT = String.raw`(function(){var p=location.pathname,r=null,m;if((m=p.match(/^\/filebox\/docs\/en(\/.*)?$/)))r=m[1]||'/';else if((m=p.match(/^\/filebox\/docs(\/.*)?$/)))r='/zh'+(m[1]||'/');else if((m=p.match(/^\/filebox\/en(\/.*)?$/)))r=m[1]||'/';if(r!==null){r=r.replace(/\.html$/,'').replace(/\/index$/,'/');location.replace('/filebox'+r+location.search+location.hash)}})()`

const enNav = [
  { text: 'Guide', link: '/guide/introduction' },
  { text: 'Features', link: '/features/browse' },
  { text: 'Ops', link: '/ops/hub' },
  { text: 'GitHub', link: 'https://github.com/ZhimingYe/filebox' },
]

const enSidebar = {
  '/guide/': [
    {
      text: 'Getting started',
      items: [
        { text: 'What is filebox', link: '/guide/introduction' },
        { text: 'Quick start', link: '/guide/quick-start' },
        { text: 'Install Hub', link: '/guide/install-hub' },
        { text: 'Install Agent', link: '/guide/install-agent' },
        { text: 'First login & add roots', link: '/guide/first-login' },
      ],
    },
  ],
  '/features/': [
    {
      text: 'How to use',
      items: [
        { text: 'Browse files', link: '/features/browse' },
        { text: 'Explorer tree', link: '/features/explorer' },
        { text: 'Preview (image / PDF / code / tables)', link: '/features/preview' },
        { text: 'Multi-tab preview', link: '/features/tabs' },
        { text: 'Workspace search', link: '/features/search' },
        { text: 'Collections', link: '/features/collections' },
        { text: 'Transfer', link: '/features/transfer' },
        { text: 'Terminal', link: '/features/terminal' },
        { text: 'System monitor', link: '/features/stats' },
        { text: 'Security & sensitive files', link: '/features/security' },
      ],
    },
  ],
  '/ops/': [
    {
      text: 'Ops & advanced',
      items: [
        { text: 'Hub config & HTTPS', link: '/ops/hub' },
        { text: 'Agent config & updates', link: '/ops/agent' },
        { text: 'Office preview (LibreOffice)', link: '/ops/office' },
        { text: 'FAQ', link: '/ops/faq' },
      ],
    },
  ],
}

const zhNav = [
  { text: '指南', link: '/zh/guide/introduction' },
  { text: '功能', link: '/zh/features/browse' },
  { text: '运维', link: '/zh/ops/hub' },
  { text: 'GitHub', link: 'https://github.com/ZhimingYe/filebox' },
]

const zhSidebar = {
  '/zh/guide/': [
    {
      text: '开始使用',
      items: [
        { text: '什么是 filebox', link: '/zh/guide/introduction' },
        { text: '快速开始', link: '/zh/guide/quick-start' },
        { text: '部署 Hub', link: '/zh/guide/install-hub' },
        { text: '部署 Agent', link: '/zh/guide/install-agent' },
        { text: '首次登录与添加目录', link: '/zh/guide/first-login' },
      ],
    },
  ],
  '/zh/features/': [
    {
      text: '怎么用',
      items: [
        { text: '浏览文件', link: '/zh/features/browse' },
        { text: 'Explorer 树形视图', link: '/zh/features/explorer' },
        { text: '预览（图 / PDF / 代码 / 表格）', link: '/zh/features/preview' },
        { text: '多标签预览', link: '/zh/features/tabs' },
        { text: '工作区搜索', link: '/zh/features/search' },
        { text: '合集 Collections', link: '/zh/features/collections' },
        { text: '临时传输 Transfer', link: '/zh/features/transfer' },
        { text: '远程终端 Terminal', link: '/zh/features/terminal' },
        { text: '系统监控', link: '/zh/features/stats' },
        { text: '安全与敏感文件', link: '/zh/features/security' },
      ],
    },
  ],
  '/zh/ops/': [
    {
      text: '运维与进阶',
      items: [
        { text: 'Hub 配置与 HTTPS', link: '/zh/ops/hub' },
        { text: 'Agent 配置与更新', link: '/zh/ops/agent' },
        { text: 'Office 预览（LibreOffice）', link: '/zh/ops/office' },
        { text: '常见问题', link: '/zh/ops/faq' },
      ],
    },
  ],
}

export default defineConfig({
  title: 'filebox',
  description:
    'Lab / HPC read-only remote file browser — Hub + Agent, no public IP / inbound ports / VPN',
  base: '/filebox/',
  cleanUrls: true,
  lastUpdated: true,
  ignoreDeadLinks: false,
  head: [
    ['link', { rel: 'icon', href: '/filebox/favicon.svg', type: 'image/svg+xml' }],
    ['meta', { name: 'theme-color', content: '#6366f1' }],
    ['meta', { property: 'og:type', content: 'website' }],
    ['meta', { property: 'og:image', content: 'https://zhimingye.github.io/filebox/screenshots/14-tabs-pdf.png' }],
    ['meta', { name: 'twitter:card', content: 'summary_large_image' }],
    // Legacy URLs → current locations. Per-page stubs on gh-pages cover known
    // pages; this catches anything else that lands on the site-wide 404 page
    // (GitHub Pages serves /404.html for unknown paths):
    //   /filebox/docs/en/<p> → /filebox/<p>     (old English under /docs/en/)
    //   /filebox/docs/<p>    → /filebox/zh/<p>  (old Chinese default under /docs/)
    //   /filebox/en/<p>      → /filebox/<p>     (English used to live at /en/)
    ['script', {}, LEGACY_REDIRECT],
  ],
  locales: {
    root: {
      label: 'English',
      lang: 'en-US',
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
            'Released under the <a href="https://github.com/ZhimingYe/filebox/blob/main/LICENSE">Apache License 2.0</a> · <a href="https://github.com/ZhimingYe/filebox">GitHub</a> · <a href="https://github.com/ZhimingYe/filebox/releases/latest">Download release</a>',
          copyright: 'Copyright © filebox contributors',
        },
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
    zh: {
      label: '中文',
      lang: 'zh-CN',
      link: '/zh/',
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
            '基于 <a href="https://github.com/ZhimingYe/filebox/blob/main/LICENSE">Apache License 2.0</a> 发布 · <a href="https://github.com/ZhimingYe/filebox">GitHub</a> · <a href="https://github.com/ZhimingYe/filebox/releases/latest">下载 Release</a>',
          copyright: 'Copyright © filebox contributors',
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
  },
  themeConfig: {
    // Local search: one index per locale; Chinese UI strings for /zh/.
    search: {
      provider: 'local',
      options: {
        locales: {
          zh: {
            translations: {
              button: { buttonText: '搜索', buttonAriaLabel: '搜索文档' },
              modal: {
                displayDetails: '显示详细列表',
                resetButtonTitle: '清除查询',
                backButtonTitle: '关闭搜索',
                noResultsText: '没有结果',
                footer: { selectText: '选择', navigateText: '切换', closeText: '关闭' },
              },
            },
          },
        },
      },
    },
  },
})
