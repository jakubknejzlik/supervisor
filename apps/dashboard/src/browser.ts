export {};

declare global {
  // Runtime records are free-form MCP data; the UI validates/normalizes them at entry.
  interface Window { SUPERVISOR_DATA?: Record<string, any> }
  interface SupervisorElementMap {
    search: HTMLInputElement;
    state: HTMLSelectElement;
    sort: HTMLSelectElement;
    'include-done': HTMLInputElement;
    'waiting-you': HTMLInputElement;
    published: HTMLTimeElement;
    'record-dialog': HTMLDialogElement;
  }
  type SupervisorElement<T extends string> = T extends keyof SupervisorElementMap
    ? SupervisorElementMap[T] : HTMLElement;
}
