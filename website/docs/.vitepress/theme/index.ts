import DefaultTheme from 'vitepress/theme'
import type { Theme } from 'vitepress'
import { h } from 'vue'
import HeroShot from './HeroShot.vue'
import './custom.css'

export default {
  extends: DefaultTheme,
  // HeroShot renders below the hero text on home pages that set `heroShot`
  // in frontmatter: a large, full-width product screenshot instead of the
  // default theme's small side image (which shrinks to ~300px on phones).
  Layout: () => h(DefaultTheme.Layout, null, { 'home-hero-after': () => h(HeroShot) }),
} satisfies Theme
