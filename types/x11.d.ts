/**
 * Minimal ambient types for the `x11` package, which ships none.
 *
 * Only the two requests coCine issues are declared: reparenting a child window
 * into the main window so a tiling window manager sees a single window, and
 * mapping it again afterwards.
 */
declare module 'x11' {
  export interface XClient {
    ReparentWindow (child: number, parent: number, x: number, y: number): void
    MapWindow (win: number): void
    UnmapWindow (win: number): void
    RaiseWindow (win: number): void
  }
  export interface XDisplay {
    client: XClient
    screen: Array<{ root: number }>
  }
  export function createClient (cb: (err: unknown, display: XDisplay) => void): void
}
