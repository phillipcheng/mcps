/**
 * Chained Task Runner
 *
 * Orchestrates sequential execution of multiple subtasks
 */

/**
 * Create a chained task runner
 * @param {Object} ctx - Context with dependencies
 * @param {Function} runJanusTask - Janus task runner
 * @param {Function} runWorkorderTask - Workorder task runner
 * @returns {Function} runChainedTask function
 */
function createChainedTaskRunner(ctx, runJanusTask, runWorkorderTask) {
  const { screenshots, tasks, saveTaskToDb } = ctx;

  /**
   * Run a chained task - executes subtasks sequentially
   */
  async function runChainedTask(taskId, task) {
    const log = (msg) => {
      const line = `[${new Date().toISOString()}] ${msg}`;
      console.log(`[${taskId}] ${msg}`);
      task.logs.push(line);
    };

    log(`Starting chained task: ${task.name}`);
    log(`Total subtasks: ${task.subtasks.length}`);

    for (let i = 0; i < task.subtasks.length; i++) {
      const subtask = task.subtasks[i];
      task.currentIndex = i;
      task.stage = `Running subtask ${i + 1}/${task.subtasks.length}`;
      await saveTaskToDb(taskId, task);

      log(`\n=== Subtask ${i + 1}/${task.subtasks.length}: ${subtask.type} ===`);
      log(`Parameters: ${JSON.stringify({
        psm: subtask.psm,
        env: subtask.env,
        idl_branch: subtask.idl_branch,
        api_group_id: subtask.api_group_id
      })}`);

      subtask.status = 'running';
      subtask.startTime = new Date().toISOString();
      await saveTaskToDb(taskId, task);

      try {
        // Create a temporary task object for the subtask
        const tempTaskId = `${taskId}_sub${i}`;
        const tempTask = {
          type: subtask.type === 'janus' ? 'janus_mini_update' :
                subtask.type === 'workorder' ? 'janus_workorder_execute' : subtask.type,
          psm: subtask.psm,
          env: subtask.env,
          idl_branch: subtask.idl_branch,
          idl_version: subtask.idl_version,
          api_group_id: subtask.api_group_id,
          status: 'running',
          logs: [],
          startTime: new Date().toISOString(),
          endTime: null,
          error: null
        };

        // Store temporarily for screenshot access
        tasks.set(tempTaskId, tempTask);
        screenshots.set(tempTaskId, []);

        // Run the appropriate task runner
        if (tempTask.type === 'janus_mini_update') {
          await runJanusTask(tempTaskId, tempTask);
        } else if (tempTask.type === 'janus_workorder_execute') {
          await runWorkorderTask(tempTaskId, tempTask);
        }

        // Copy results back to subtask
        subtask.status = tempTask.status;
        subtask.logs = tempTask.logs;
        subtask.endTime = tempTask.endTime || new Date().toISOString();
        subtask.error = tempTask.error;
        subtask.result = tempTask.result;
        subtask.stage = tempTask.stage;

        // Copy screenshots to main task
        const subScreenshots = screenshots.get(tempTaskId) || [];
        const mainScreenshots = screenshots.get(taskId) || [];
        for (const ss of subScreenshots) {
          mainScreenshots.push({
            ...ss,
            label: `[${i + 1}] ${ss.label}`
          });
        }
        screenshots.set(taskId, mainScreenshots);

        // Clean up temp task
        tasks.delete(tempTaskId);
        screenshots.delete(tempTaskId);

        // Log subtask result
        if (subtask.status === 'completed') {
          log(`Subtask ${i + 1} completed: ${subtask.result || 'Success'}`);
        } else if (subtask.status === 'error') {
          log(`Subtask ${i + 1} failed: ${subtask.error}`);
          // Stop chain on error
          task.status = 'error';
          task.error = `Subtask ${i + 1} failed: ${subtask.error}`;
          task.endTime = new Date().toISOString();
          await saveTaskToDb(taskId, task);
          return;
        }

      } catch (err) {
        subtask.status = 'error';
        subtask.error = err.message;
        subtask.endTime = new Date().toISOString();
        log(`Subtask ${i + 1} exception: ${err.message}`);

        // Stop chain on error
        task.status = 'error';
        task.error = `Subtask ${i + 1} exception: ${err.message}`;
        task.endTime = new Date().toISOString();
        await saveTaskToDb(taskId, task);
        return;
      }

      await saveTaskToDb(taskId, task);

      // Small delay between subtasks
      if (i < task.subtasks.length - 1) {
        log('Waiting 2 seconds before next subtask...');
        await new Promise(r => setTimeout(r, 2000));
      }
    }

    // All subtasks completed
    task.status = 'completed';
    task.stage = 'All subtasks completed';
    task.endTime = new Date().toISOString();
    task.result = `Completed ${task.subtasks.length} subtasks`;
    log(`\n=== Chained task completed! ===`);
    log(`Total subtasks: ${task.subtasks.length}`);
    await saveTaskToDb(taskId, task);
  }

  return runChainedTask;
}

module.exports = { createChainedTaskRunner };
