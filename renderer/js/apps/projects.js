import { h, basename } from '../core/dom.js';
import { call, bus } from '../core/api.js';
import { project, pickProject, openProject } from '../core/project.js';
import { prompt, confirm, toast, fail } from '../core/ui.js';

export default {
  id: 'projects', title: 'Projects', icon: 'folder', desc: 'Open and manage recent projects', size: [520, 460], min: [320, 240],
  async create(win) {
    const list = h('div.projects-list.scroll.fill');
    const openButton = h('button.btn.primary', 'OPEN FOLDER');
    const createButton = h('button.btn.ghost', 'NEW PROJECT');
    const toolbar = h('div.toolbar', openButton, createButton);
    win.body.append(toolbar, list);

    function render() {
      list.replaceChildren();
      if (!project.recent.length) {
        list.append(h('div.empty', h('div', h('b', 'NO RECENT PROJECTS'), 'Open a folder to add it here.')));
        return;
      }
      for (const root of project.recent) {
        const current = root === project.root;
        const row = h('div.projects-row',
          h('div.projects-info',
            h('b', basename(root)),
            h('span.projects-path', root),
            current ? h('span.projects-current', 'CURRENT PROJECT') : null
          ),
          h('button.btn.ghost', { type: 'button', title: 'Open project', on: {
            click: () => openProject(root)
          } }, current ? 'ACTIVE' : 'OPEN'),
          h('button.btn.ghost', { type: 'button', title: 'Remove from recent projects', on: {
            click: () => removeRecent(root)
          } }, '×')
        );
        list.append(row);
      }
    }

    async function removeRecent(root) {
      if (root === project.root && !(await confirm(
        'REMOVE ACTIVE PROJECT',
        'Remove this folder from recent projects? The project remains open until you switch folders.',
        { ok: 'REMOVE' }
      ))) return;
      const recent = project.recent.filter((item) => item !== root);
      try {
        await call('store:set', 'recent', recent);
        project.recent = recent;
        render();
      } catch (error) {
        fail(error, 'SAVE RECENT PROJECTS');
      }
    }

    openButton.addEventListener('click', () => pickProject().catch((error) => fail(error, 'OPEN PROJECT')));
    createButton.addEventListener('click', async () => {
      const path = await prompt('Create project folder', '', {
        label: 'Absolute path for the new project directory',
        placeholder: 'C:\\Users\\you\\Projects\\new-project'
      });
      if (!path?.trim()) return;
      try {
        const root = await call('fs:mkdir', path.trim());
        await openProject(root);
      } catch (error) {
        fail(error, 'CREATE PROJECT');
      }
    });

    const offProject = bus.on('project:changed', render);
    render();
    return { destroy: offProject };
  }
};
