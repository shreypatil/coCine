import { randomBytes } from 'node:crypto'
import { generateCode } from '@cocine/protocol'
import { Room } from './room.js'

/**
 * Rooms are held behind an interface so the Redis-backed implementation can
 * arrive without touching the server.
 *
 * Redis is deliberately not here yet: it only earns its keep once there is more
 * than one server process, and a single small instance is what the project
 * actually needs. Adding it now would mean running a second daemon in
 * development to buy scaling nobody has asked for.
 */
export interface RoomStore {
  create (startLeadMs: number): Room
  get (code: string): Room | undefined
  delete (code: string): void
  /** Rooms empty for longer than this are collected. */
  sweep (emptyForMs: number, nowMs?: number): number
  size (): number
}

export class InMemoryRoomStore implements RoomStore {
  private rooms = new Map<string, Room>()

  create (startLeadMs: number): Room {
    // Retry on the vanishingly unlikely collision rather than assume.
    for (let i = 0; i < 8; i++) {
      const code = generateCode(n => randomBytes(n))
      if (!this.rooms.has(code)) {
        const room = new Room(code, startLeadMs)
        this.rooms.set(code, room)
        return room
      }
    }
    throw new Error('could not allocate a room code')
  }

  get (code: string): Room | undefined { return this.rooms.get(code) }
  delete (code: string): void { this.rooms.delete(code) }
  size (): number { return this.rooms.size }

  sweep (emptyForMs: number, nowMs = Date.now()): number {
    let removed = 0
    for (const [code, room] of this.rooms) {
      if (room.lastEmptyAtMs !== null && nowMs - room.lastEmptyAtMs > emptyForMs) {
        this.rooms.delete(code)
        removed++
      }
    }
    return removed
  }
}
