import { createRouter, createWebHashHistory } from 'vue-router'
import AppShell from '../layout/AppShell.vue'

const router = createRouter({
  history: createWebHashHistory(),
  routes: [
    {
      path: '/',
      component: AppShell,
      children: [
        { path: '', name: 'home', component: () => import('../views/HomeView.vue') },
        { path: 'chat/:id', name: 'chat', component: () => import('../views/ChatViewPage.vue') },
        {
          path: 'chat/:id/settings',
          name: 'chat-settings',
          component: () => import('../views/ChatSettingsPage.vue')
        },
        {
          path: 'character/new',
          name: 'character-new',
          component: () => import('../views/CharacterEditorPage.vue')
        },
        {
          path: 'character/:id/edit',
          name: 'character-edit',
          component: () => import('../views/CharacterEditorPage.vue')
        },
        {
          path: 'persona/new',
          name: 'persona-new',
          component: () => import('../views/PersonaEditorPage.vue')
        },
        {
          path: 'persona/:id/edit',
          name: 'persona-edit',
          component: () => import('../views/PersonaEditorPage.vue')
        },
        { path: 'settings', name: 'settings', component: () => import('../views/SettingsView.vue') },
        { path: 'models', name: 'models', component: () => import('../views/ModelsPage.vue') }
      ]
    }
  ]
})

export default router
