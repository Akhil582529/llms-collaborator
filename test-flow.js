/**
 * One-shot end-to-end test: submits a requirement, lets the orchestrator
 * auto-dispatch every subtask, then prints the final task state and the
 * files each subtask actually wrote.
 */

require('dotenv').config();
const orchestrator = require('./src/orchestrator');
require('./src/fileWatcher').start(); // so we can also see watcher logs during the run

async function main() {
  console.log('--- submitting requirement ---');
  const task = await orchestrator.submitRequirement('a todo list app with login', {
    techStack: { frontend: 'react', backend: 'express', database: 'sqlite' },
  });

  console.log('\n--- final task state ---');
  console.log(JSON.stringify(task, null, 2));

  console.log('\n--- summary ---');
  task.subtasks.forEach((s) => {
    console.log(`[${s.status}] ${s.agent} — ${s.description}`);
    s.files.forEach((f) => console.log(`    wrote: ${f}`));
  });

  const allDone = task.subtasks.every((s) => s.status === 'done');
  console.log(`\noverall: ${allDone ? 'ALL SUBTASKS DONE ✅' : 'SOMETHING DID NOT COMPLETE ❌'}`);

  process.exit(allDone ? 0 : 1);
}

main().catch((err) => {
  console.error('--- FAILED ---');
  console.error(err);
  process.exit(1);
});
