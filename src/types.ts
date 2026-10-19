export type RoomStatus = 'cleaning' | 'done' | 'available' | 'occupied';
export type AppRole = 'manager' | 'staff';

export interface Room {
  id: string;
  roomNumber: string;
  status: RoomStatus;
  type: string;
  assignedToday: boolean;
  updatedAt: any;
  lastAction?: 'check_in' | 'check_out' | 'none' | 'reset' | 'clean' | 'mid_clean';
  memo?: string;
}

export enum OperationType {
  CREATE = 'create',
  UPDATE = 'update',
  DELETE = 'delete',
  LIST = 'list',
  GET = 'get',
  WRITE = 'write',
}
