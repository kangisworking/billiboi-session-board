export type Task = { id: string; text: string; status: 'pending' | 'in_progress' | 'completed' | 'deleted'; active?: string }

declare module 'claude-code' {
  interface PluginState {
    'peer-status-writer': { tasks: Shaped<Task[]> }
  }
}
