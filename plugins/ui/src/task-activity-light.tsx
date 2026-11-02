import { defaultTaskActivity, taskActivityClass, taskActivityLabel, type TaskActivity } from './task-activity.ts';

export function TaskActivityLight({ state, activity, className = '' }: { state: string; activity?: TaskActivity; className?: string }) {
  const value = activity ?? defaultTaskActivity(state), label = taskActivityLabel(value);
  return <i className={`${className} ${taskActivityClass(value)}`} title={label} role="img" aria-label={label} />;
}
