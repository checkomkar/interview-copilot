/** Display an Electron accelerator the way Windows users expect. */
export function formatHotkey(accel: string): string {
  return accel.replace(/CommandOrControl|CmdOrCtrl/g, 'Ctrl').replace(/\+/g, ' + ')
}
