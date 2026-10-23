export type RoomMemberStatus = "pending" | "approved" | "removed";

export interface RoomMember {
  userId: string;
  displayName: string;
  status: RoomMemberStatus;
}

export interface CollaborationRoom {
  code: string;
  ownerId: string;
  members: RoomMember[];
}

export type CollaborationMessage =
  | { type: "auth"; token: string }
  | { type: "room.create"; userId: string; displayName: string }
  | { type: "room.join.request"; code: string; userId: string; displayName: string }
  | { type: "room.join.approve"; code: string; userId: string }
  | { type: "room.member.remove"; code: string; userId: string }
  | { type: "room.leave"; code: string }
  | { type: "editor.change"; code: string; path: string; content: string; revision: number };

export type CollaborationEvent =
  | { type: "room.created"; room: CollaborationRoom }
  | { type: "room.join.requested"; room: CollaborationRoom; userId: string }
  | { type: "room.updated"; room: CollaborationRoom }
  | { type: "editor.changed"; code: string; path: string; content: string; revision: number; by: string }
  | { type: "error"; code: string; message: string };

export function createRoomCode(random = Math.random): string {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789";
  let code = "";
  for (let index = 0; index < 6; index += 1) {
    code += alphabet[Math.floor(random() * alphabet.length)];
  }
  return code;
}

export function canJoinRoom(room: CollaborationRoom, userId: string): boolean {
  return room.members.some((member) => member.userId === userId && member.status === "approved");
}

export function isRoomCode(value: string): boolean {
  return /^[A-Za-z0-9]{6}$/.test(value);
}
