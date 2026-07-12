/// <reference types="vite/client" />

import type { OpenCharUiApi } from '@shared/api'

declare module '*.vue' {
  import type { DefineComponent } from 'vue'
  const component: DefineComponent<object, object, unknown>
  export default component
}

declare global {
  interface Window {
    api: OpenCharUiApi
  }
}

export {}