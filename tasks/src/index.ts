import type { Plugin } from '@inkandswitch/patchwork-plugins';

const STYLE_ID = 'tasks-styles';

async function loadStyles() {
  const url = new URL('./index.css', import.meta.url);
  return (await fetch(url)).text();
}

function addStyles(textContent: string) {
  if (document.head.querySelector(`#${STYLE_ID}`)) return;
  const el = document.createElement('style');
  Object.assign(el, { textContent, id: STYLE_ID });
  document.head.append(el);
}

export const plugins: Plugin<any>[] = [
  {
    type: 'patchwork:datatype',
    id: 'task-queue',
    name: 'Task Queue',
    icon: 'CirclePlus',
    load: async () => (await import('./datatype')).TaskQueueDatatype
  },
  {
    type: 'patchwork:tool',
    id: 'task-queue-browser',
    name: 'Task Queue Browser',
    icon: 'CirclePlus',
    supportedDatatypes: ['task-queue'],
    load: async () => {
      const [styles, tool] = await Promise.all([
        loadStyles(),
        import('./task-queue-tool'),
      ]);
      addStyles(styles);
      return tool.TaskQueueTool;
    },
  },
  {
    type: 'patchwork:tool',
    id: 'task-titlebar',
    name: 'Task Titlebar',
    icon: 'Square',
    supportedDatatypes: '*',
    unlisted: true,
    tags: ['titlebar-tool'],
    load: async () => {
      const [styles, tool] = await Promise.all([
        loadStyles(),
        import('./titlebar-tool'),
      ]);
      addStyles(styles);
      return tool.TitlebarTool;
    },
  },
];
