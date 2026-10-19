import React, { useState, useEffect, useMemo } from 'react';
import { 
  collection, 
  onSnapshot, 
  doc, 
  updateDoc, 
  addDoc, 
  query, 
  orderBy,
  serverTimestamp,
  getDocs,
  setDoc,
  writeBatch,
  getDocFromServer,
  deleteField
} from 'firebase/firestore';
import { onAuthStateChanged, User } from 'firebase/auth';
import { 
  LogOut, 
  LogIn, 
  CheckCircle2, 
  Clock, 
  RefreshCw, 
  Bed,
  Building,
  CircleDot,
  Edit2,
  X,
  Trash2
} from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';
import { db, auth, signIn, logout } from './lib/firebase.ts';
import { Room, RoomStatus, OperationType, AppRole } from './types.ts';

// Helper for error handling as per guidelines
function handleFirestoreError(error: unknown, operationType: OperationType, path: string | null) {
  const errInfo = {
    error: error instanceof Error ? error.message : String(error),
    authInfo: {
      userId: auth.currentUser?.uid,
      email: auth.currentUser?.email,
    },
    operationType,
    path
  };
  console.error('Firestore Error: ', JSON.stringify(errInfo));
  throw new Error(JSON.stringify(errInfo));
}

const statusLabels: Record<RoomStatus, string> = {
  cleaning: '청소중',
  done: '청소완료',
  available: '공실',
  occupied: '사용중'
};

const statusColors: Record<RoomStatus, string> = {
  cleaning: 'bg-[rgba(212,175,55,0.1)] text-[#D4AF37] border-[rgba(212,175,55,0.3)]',
  done: 'bg-[rgba(34,197,94,0.1)] text-[#22C55E] border-[rgba(34,197,94,0.3)]',
  available: 'bg-[rgba(96,165,250,0.1)] text-[#60A5FA] border-[rgba(96,165,250,0.3)]',
  occupied: 'bg-[rgba(255,255,255,0.05)] text-slate-400 border-[rgba(255,255,255,0.1)]'
};

// RoomMemo component for real-time note syncing
const RoomMemo = ({ room, onUpdate }: { room: Room, onUpdate: (memo: string) => void }) => {
  const [localMemo, setLocalMemo] = useState(room.memo || '');
  const [isFocused, setIsFocused] = useState(false);

  // Sync with server data if not currently typing
  useEffect(() => {
    if (!isFocused) {
      setLocalMemo(room.memo || '');
    }
  }, [room.memo, isFocused]);

  const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const newValue = e.target.value;
    setLocalMemo(newValue);
  };

  // Debounced update
  useEffect(() => {
    if (!isFocused) return;
    
    const timer = setTimeout(() => {
      if (localMemo !== (room.memo || '')) {
        onUpdate(localMemo);
      }
    }, 500); // 500ms debounce

    return () => clearTimeout(timer);
  }, [localMemo, isFocused, room.memo, onUpdate]);

  const handleBlur = () => {
    setIsFocused(false);
    if (localMemo !== (room.memo || '')) {
      onUpdate(localMemo);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      (e.target as HTMLInputElement).blur();
    }
  };

  return (
    <div className="relative group/memo">
      <input 
        type="text"
        value={localMemo}
        placeholder="메모 입력..."
        onFocus={() => setIsFocused(true)}
        onBlur={handleBlur}
        onChange={handleChange}
        onKeyDown={handleKeyDown}
        className="w-full bg-white/5 border border-white/5 px-3 py-2 pr-8 text-[11px] text-white/80 placeholder:text-white/10 focus:border-accent/30 focus:outline-none transition-all rounded-sm"
      />
      {localMemo && (
        <button 
          onClick={() => {
            setLocalMemo('');
            onUpdate('');
          }}
          className="absolute right-2 top-1/2 -translate-y-1/2 text-white/20 hover:text-white/60 transition-colors"
        >
          <X size={12} />
        </button>
      )}
    </div>
  );
};

export default function App() {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);
  const [signingIn, setSigningIn] = useState(false);
  const [rooms, setRooms] = useState<Room[]>([]);
  const [lastSync, setLastSync] = useState<Date>(new Date());
  const [isSyncing, setIsSyncing] = useState(false);
  const [isInitializing, setIsInitializing] = useState(false);
  const [isMenuOpen, setIsMenuOpen] = useState(false);
  const [selectedRole, setSelectedRole] = useState<AppRole | null>(() => {
    return (sessionStorage.getItem('arustay_role') as AppRole) || null;
  });

  useEffect(() => {
    const testConnection = async () => {
      try {
        await getDocFromServer(doc(db, 'test-connection', 'test'));
      } catch (error) {
        if(error instanceof Error && error.message.includes('the client is offline')) {
          console.error("Please check your Firebase configuration.");
        }
      }
    };
    testConnection();

    const unsubscribe = onAuthStateChanged(auth, (u) => {
      setUser(u);
      setLoading(false);
    });
    return () => unsubscribe();
  }, []);

  const handleRoleSelection = async (role: AppRole) => {
    try {
      setSigningIn(true);
      sessionStorage.setItem('arustay_role', role);
      setSelectedRole(role);
      await signIn();
    } catch (error) {
      console.error('Sign in error:', error);
      setSelectedRole(null);
      sessionStorage.removeItem('arustay_role');
    } finally {
      setSigningIn(false);
    }
  };

  const handleLogout = async () => {
    sessionStorage.removeItem('arustay_role');
    setSelectedRole(null);
    await logout();
  };

  // Sync rooms in real-time
  useEffect(() => {
    if (!user) {
      setRooms([]);
      return;
    }

    console.log(`Setting up real-time sync for ${user.email} (${selectedRole})`);
    
    // Explicitly fetch once to ensure we have data even if snapshot is slow
    const fetchInitial = async () => {
      try {
        const q = query(collection(db, 'rooms'), orderBy('roomNumber', 'asc'));
        const snap = await getDocs(q);
        const data = snap.docs.map(d => ({ id: d.id, ...d.data() } as Room));
        console.log(`Initial fetch success: ${data.length} rooms`);
        setRooms(data);
      } catch (e) {
        console.error("Initial fetch error detail:", e);
        // Map to standard error format for consistency if it's a permission error
        if (e instanceof Error && e.message.includes('permission')) {
          handleFirestoreError(e, OperationType.LIST, 'rooms');
        }
      }
    };
    fetchInitial();

    const q = query(collection(db, 'rooms'), orderBy('roomNumber', 'asc'));
    const unsubscribe = onSnapshot(q, { includeMetadataChanges: true }, (snapshot) => {
      setIsSyncing(true);
      const roomData: Room[] = snapshot.docs.map(doc => ({
        id: doc.id,
        ...doc.data()
      } as Room));
      
      setRooms(roomData);
      setLastSync(new Date());
      
      // Keep syncing indicator for a moment
      setTimeout(() => setIsSyncing(false), 800);
    }, (error) => {
      handleFirestoreError(error, OperationType.LIST, 'rooms');
    });

    return () => {
      console.log("Cleaning up listener");
      unsubscribe();
    };
  }, [user, selectedRole]);

  const filteredRooms = useMemo(() => {
    return rooms.filter(r => !['204', '304', '504', '604'].includes(r.roomNumber));
  }, [rooms]);

  const stats = useMemo(() => {
    const totalRooms = filteredRooms.length;
    const checkedIn = filteredRooms.filter(r => r.status === 'occupied').length;
    const cleaningRequired = filteredRooms.filter(r => r.status === 'cleaning').length;
    const cleaningDone = filteredRooms.filter(r => r.status === 'done').length;

    let progress = 0;
    let progressTotal = 0;
    let progressCurrent = 0;

    if (selectedRole === 'manager') {
      progressTotal = totalRooms;
      progressCurrent = totalRooms - cleaningRequired;
      progress = totalRooms > 0 ? (progressCurrent / progressTotal) * 100 : 0;
    } else {
      const staffTasks = filteredRooms.filter(r => r.status === 'cleaning' || r.status === 'done');
      progressTotal = staffTasks.length;
      progressCurrent = cleaningDone;
      progress = progressTotal > 0 ? (progressCurrent / progressTotal) * 100 : 0;
    }
    
    return {
      progress: Math.round(progress),
      progressTotal,
      progressCurrent,
      checkedIn,
      cleaningRequired,
      cleaningDone,
      totalRooms
    };
  }, [filteredRooms, selectedRole]);

  const updateRoomStatus = async (room: Room, status: RoomStatus) => {
    try {
      await updateDoc(doc(db, 'rooms', room.id), {
        status,
        updatedAt: serverTimestamp()
      });
    } catch (error) {
      handleFirestoreError(error, OperationType.UPDATE, `rooms/${room.id}`);
    }
  };

  const updateRoomMemo = async (room: Room, memo: string) => {
    try {
      await updateDoc(doc(db, 'rooms', room.id), {
        memo,
        updatedAt: serverTimestamp()
      });
    } catch (error) {
      handleFirestoreError(error, OperationType.UPDATE, `rooms/${room.id}`);
    }
  };

  const clearAllMemos = async () => {
    if (!window.confirm('모든 객실의 메모를 삭제하시겠습니까?')) return;
    
    try {
      const batch = writeBatch(db);
      rooms.forEach(room => {
        if (room.memo) {
          batch.update(doc(db, 'rooms', room.id), {
            memo: deleteField(),
            updatedAt: serverTimestamp()
          });
        }
      });
      await batch.commit();
    } catch (error) {
      handleFirestoreError(error, OperationType.WRITE, 'rooms/batch-clear-memos');
    }
  };

  const handleCheckInOut = async (room: Room, action: 'check_in' | 'check_out' | 'clean' | 'mid_clean') => {
    try {
      await updateDoc(doc(db, 'rooms', room.id), {
        lastAction: action,
        status: 'cleaning',
        updatedAt: serverTimestamp()
      });
    } catch (error) {
      handleFirestoreError(error, OperationType.UPDATE, `rooms/${room.id}`);
    }
  };

  const cancelCleaning = async (room: Room) => {
    try {
      const targetStatus = room.lastAction === 'mid_clean' ? 'occupied' : 'available';
      await updateDoc(doc(db, 'rooms', room.id), {
        status: targetStatus,
        updatedAt: serverTimestamp()
      });
    } catch (error) {
      handleFirestoreError(error, OperationType.UPDATE, `rooms/${room.id}`);
    }
  };

  const initializeRooms = async () => {
    if (isInitializing) return;
    setIsInitializing(true);
    const roomList: { roomNumber: string; status: RoomStatus; type: string; assignedToday: boolean }[] = [];
    
    // 101, 102
    roomList.push({ roomNumber: '101', status: 'done', type: 'Standard', assignedToday: true });
    roomList.push({ roomNumber: '102', status: 'cleaning', type: 'Standard', assignedToday: true });
    
    // 201~206
    ['201', '202', '203', '205', '206'].forEach((num, i) => {
      roomList.push({ 
        roomNumber: num, 
        status: i % 3 === 0 ? 'available' : (i % 3 === 1 ? 'cleaning' : 'done'), 
        type: 'Double', 
        assignedToday: i < 4 
      });
    });

    // 301~306
    ['301', '302', '303', '305', '306'].forEach((num, i) => {
      roomList.push({ 
        roomNumber: num, 
        status: i % 2 === 0 ? 'available' : 'occupied', 
        type: 'Triple', 
        assignedToday: i < 3 
      });
    });

    // 501~506
    ['501', '502', '503', '505', '506'].forEach((num, i) => {
      roomList.push({ 
        roomNumber: num, 
        status: 'available', 
        type: 'Double', 
        assignedToday: true 
      });
    });

    // 601~606
    ['601', '602', '603', '605', '606'].forEach((num, i) => {
      roomList.push({ 
        roomNumber: num, 
        status: 'occupied', 
        type: 'Suite', 
        assignedToday: false 
      });
    });

    // 701~703
    ['701', '702', '703'].forEach((num, i) => {
      roomList.push({ 
        roomNumber: num, 
        status: 'cleaning', 
        type: 'Suite', 
        assignedToday: true 
      });
    });

    try {
      const batch = writeBatch(db);
      
      roomList.forEach((r) => {
        // Use roomNumber as the document ID to prevent duplicates and ensure all are created
        const roomRef = doc(db, 'rooms', r.roomNumber);
        batch.set(roomRef, {
          ...r,
          updatedAt: serverTimestamp(),
          lastAction: 'none'
        }, { merge: true });
      });

      await batch.commit();
      console.log('Successfully initialized all rooms');
    } catch (error) {
      handleFirestoreError(error, OperationType.WRITE, 'rooms/batch');
    } finally {
      setIsInitializing(false);
    }
  };

  const clearAllRooms = async () => {
    if (!window.confirm('모든 객실을 공실 상태로 초기화하시겠습니까?')) return;
    
    try {
      const batch = writeBatch(db);
      rooms.forEach(room => {
        batch.update(doc(db, 'rooms', room.id), {
          status: 'available',
          assignedToday: false,
          staffEmail: null,
          updatedAt: serverTimestamp(),
          lastAction: 'reset'
        });
      });
      await batch.commit();
    } catch (error) {
      handleFirestoreError(error, OperationType.UPDATE, 'rooms/batch');
    }
  };

  const SidebarContent = () => (
    <div className="flex flex-col justify-between h-full">
      <div className="space-y-12 lg:space-y-16">
        <div>
          <h1 className="font-serif text-3xl font-light tracking-[0.15em] text-accent mb-1 group cursor-default capitalize">
            ARUSTAY
          </h1>
          <div className="flex items-center gap-2">
            <p className="text-[10px] tracking-[0.25em] opacity-40 uppercase">Hostel Management</p>
            <span className="text-[9px] px-1.5 py-0.5 bg-accent/10 text-accent border border-accent/20 font-bold uppercase tracking-widest">{selectedRole}</span>
          </div>
        </div>

        <div className="space-y-8">
          <div>
            <p className="text-[10px] uppercase tracking-[0.2em] opacity-40 mb-3">
              {selectedRole === 'manager' ? "Hotel Status" : "Cleaning Progress"}
            </p>
            <div className="flex justify-between items-end mb-3">
              <span className="font-serif text-5xl font-light">{stats.progress}<span className="text-xl ml-1">%</span></span>
              <span className="text-xs opacity-50 tracking-wide">{stats.progressCurrent} / {stats.progressTotal} {selectedRole === 'manager' ? 'Ready' : 'Tasks'}</span>
            </div>
            <div className="h-1 bg-border-subtle rounded-full overflow-hidden">
              <motion.div 
                initial={{ width: 0 }}
                animate={{ width: `${stats.progress}%` }}
                className="h-full bg-accent shadow-[0_0_12px_rgba(197,160,89,0.5)]"
              />
            </div>
          </div>

          <div className="pt-6 space-y-5">
            <div className="flex justify-between border-b border-border-subtle/50 pb-3 items-center">
              <span className="text-xs opacity-50 font-light tracking-wide">Checked In</span>
              <span className="font-serif text-lg">{String(stats.checkedIn).padStart(2, '0')}</span>
            </div>
            <div className="flex justify-between border-b border-border-subtle/50 pb-3 items-center">
              <span className="text-xs opacity-50 font-light tracking-wide">Cleaning Required</span>
              <span className="font-serif text-lg text-accent">{String(stats.cleaningRequired).padStart(2, '0')}</span>
            </div>
            <div className="flex justify-between border-b border-border-subtle/50 pb-3 items-center">
              <span className="text-xs opacity-50 font-light tracking-wide">Total Rooms</span>
              <span className="font-serif text-lg opacity-40">{String(stats.totalRooms).padStart(2, '0')}</span>
            </div>
          </div>
        </div>
      </div>

      <div className="mt-12 space-y-6">
        <div className="bg-card p-4 border border-border-subtle">
          <div className="flex items-center gap-3 mb-2">
            <div className="w-1.5 h-1.5 rounded-full bg-emerald-500 shadow-[0_0_8px_rgba(16,185,129,0.5)]" />
            <span className="text-[9px] tracking-[0.2em] uppercase font-bold opacity-60">System Operational</span>
          </div>
          <p className="text-[10px] opacity-30 flex items-center gap-1.5 transition-all duration-500 mb-2">
            <Clock size={10} />
            Last Sync: {lastSync.toLocaleTimeString()}
          </p>
          <div className="pt-2 border-t border-white/5">
            <p className="text-[9px] opacity-20 uppercase tracking-widest font-bold mb-1">Authenticated As</p>
            <p className="text-[10px] text-accent/60 truncate italic">{user?.email}</p>
          </div>
        </div>
        
        <button 
          onClick={handleLogout}
          className="flex items-center gap-3 text-[10px] uppercase tracking-[0.2em] opacity-40 hover:opacity-100 hover:text-red-400 transition-all font-bold"
        >
          <LogOut size={14} />
          Sign Out
        </button>
      </div>
    </div>
  );

  if (loading) {
    return (
      <div className="min-h-screen bg-[#0A0A0B] flex items-center justify-center p-4">
        <div className="animate-spin text-accent">
          <RefreshCw size={32} />
        </div>
      </div>
    );
  }

  if (!user || !selectedRole) {
    return (
      <div className="min-h-screen bg-[#0A0A0B] flex items-center justify-center p-4">
        <motion.div 
          initial={{ opacity: 0, scale: 0.95 }}
          animate={{ opacity: 1, scale: 1 }}
          className="bg-card p-10 border border-border-subtle w-full max-w-lg text-center rounded-sm shadow-2xl"
        >
          <div className="mb-10 text-center">
            <h1 className="font-serif text-4xl font-light tracking-[0.2em] text-accent mb-2">ARUSTAY</h1>
            <p className="text-[10px] tracking-[0.3em] uppercase opacity-40">Hostel Management</p>
          </div>
          
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 mb-8">
            <button 
              onClick={() => handleRoleSelection('manager')}
              disabled={signingIn}
              className="flex flex-col items-center justify-center p-8 bg-white/5 border border-white/5 hover:border-accent group transition-all disabled:opacity-50 disabled:cursor-not-allowed"
            >
              <div className="w-12 h-12 rounded-full border border-white/10 flex items-center justify-center mb-4 group-hover:bg-accent group-hover:text-black transition-all">
                <Building size={24} />
              </div>
              <span className="text-xs font-bold uppercase tracking-widest">Manager</span>
              <span className="text-[10px] opacity-30 mt-2">관리자</span>
            </button>
            <button 
              onClick={() => handleRoleSelection('staff')}
              disabled={signingIn}
              className="flex flex-col items-center justify-center p-8 bg-white/5 border border-white/5 hover:border-accent group transition-all disabled:opacity-50 disabled:cursor-not-allowed"
            >
              <div className="w-12 h-12 rounded-full border border-white/10 flex items-center justify-center mb-4 group-hover:bg-accent group-hover:text-black transition-all">
                <RefreshCw size={24} />
              </div>
              <span className="text-xs font-bold uppercase tracking-widest">Staff</span>
              <span className="text-[10px] opacity-30 mt-2">알바생</span>
            </button>
          </div>

          <p className="text-[10px] opacity-20 uppercase tracking-widest">
            {signingIn ? 'Signing in...' : 'Select your role to start session'}
          </p>
        </motion.div>
      </div>
    );
  }

  return (
    <div className="flex flex-col lg:flex-row h-screen bg-[#0A0A0B] text-[#E5E5E7] font-sans overflow-hidden">
      {/* Desktop Sidebar */}
      <aside className="hidden lg:flex w-80 flex-col border-r border-border-subtle p-10 h-full overflow-y-auto">
        <SidebarContent />
      </aside>

      {/* Mobile Header */}
      <header className="lg:hidden flex items-center justify-between p-6 bg-card border-b border-border-subtle z-50">
        <div className="flex items-center gap-3">
          <button 
            onClick={() => setIsMenuOpen(!isMenuOpen)}
            className="p-2 -ml-2 text-accent"
          >
            <div className="w-5 h-4 flex flex-col justify-between">
              <span className={`w-full h-0.5 bg-current transition-transform ${isMenuOpen ? 'rotate-45 translate-y-1.5' : ''}`} />
              <span className={`w-full h-0.5 bg-current transition-opacity ${isMenuOpen ? 'opacity-0' : ''}`} />
              <span className={`w-full h-0.5 bg-current transition-transform ${isMenuOpen ? '-rotate-45 -translate-y-2' : ''}`} />
            </div>
          </button>
          <span className="font-serif text-xl tracking-widest text-accent uppercase">{selectedRole} BOARD</span>
        </div>
        <div className="text-[10px] font-bold opacity-40 uppercase tracking-widest">ARUSTAY</div>
      </header>

      {/* Mobile Drawer Overlay */}
      <AnimatePresence>
        {isMenuOpen && (
          <>
            <motion.div 
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              onClick={() => setIsMenuOpen(false)}
              className="fixed inset-0 bg-black/80 backdrop-blur-sm z-[60] lg:hidden"
            />
            <motion.div 
              initial={{ x: '-100%' }}
              animate={{ x: 0 }}
              exit={{ x: '-100%' }}
              transition={{ type: 'spring', damping: 25, stiffness: 200 }}
              className="fixed top-0 left-0 bottom-0 w-[80vw] max-w-sm bg-card z-[70] lg:hidden p-10 border-r border-border-subtle overflow-y-auto"
            >
              <SidebarContent />
            </motion.div>
          </>
        )}
      </AnimatePresence>

      {/* Main Content */}
      <main className="flex-1 p-6 lg:p-12 overflow-y-auto">
        <header className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-6 mb-10 lg:mb-12">
          <div>
            <h2 className="font-serif text-3xl font-light tracking-tight mb-1 capitalize text-white">
              {selectedRole === 'manager' ? '객실 관리 보드' : '청소 현황판'}
            </h2>
            <p className="text-[10px] opacity-30 tracking-[0.2em] uppercase font-bold">Inventory & Operations Management</p>
          </div>
          
          <div className="flex w-full sm:w-auto gap-3 items-center">
            <AnimatePresence>
              {isSyncing && (
                <motion.div 
                  initial={{ opacity: 0, x: 10 }}
                  animate={{ opacity: 1, x: 0 }}
                  exit={{ opacity: 0 }}
                  className="flex items-center gap-2 text-[9px] text-accent uppercase tracking-widest font-bold bg-white/5 px-2 py-1 rounded-sm border border-accent/20"
                >
                  <RefreshCw size={12} className="animate-spin" />
                  Live Syncing...
                </motion.div>
              )}
            </AnimatePresence>
            {rooms.length === 0 ? (
              <button 
                onClick={initializeRooms}
                disabled={isInitializing}
                className="w-full sm:w-auto bg-accent text-black px-8 py-3 text-[10px] font-bold tracking-[0.2em] uppercase hover:brightness-110 active:scale-95 transition-all"
              >
                {isInitializing ? 'Generating...' : 'Init Data'}
              </button>
            ) : (
              <div className="flex w-full sm:w-auto gap-3">
                {selectedRole === 'manager' && (
                  <>
                    <button 
                      onClick={clearAllMemos}
                      className="flex items-center gap-2 border border-white/10 px-4 py-3 text-[9px] font-bold tracking-[0.2em] uppercase hover:text-accent hover:border-accent/30 transition-all text-slate-400"
                    >
                      <Trash2 size={12} />
                      Clear All Notes
                    </button>
                    <button 
                      onClick={clearAllRooms}
                      className="flex-1 sm:flex-none border border-white/10 px-4 py-3 text-[9px] font-bold tracking-[0.2em] uppercase hover:text-red-400 hover:border-red-400/30 transition-all text-slate-500"
                    >
                      Clear Database
                    </button>
                  </>
                )}
              </div>
            )}
          </div>
        </header>

        {/* Room Grid */}
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4 lg:gap-6">
          <AnimatePresence mode="popLayout">
            {(selectedRole === 'manager' 
              ? filteredRooms 
              : filteredRooms.filter(r => r.status === 'cleaning')
            ).length > 0 ? (
              (selectedRole === 'manager' 
                ? filteredRooms 
                : filteredRooms.filter(r => r.status === 'cleaning')
              ).map((room) => (
                <motion.div
                  key={room.id}
                  layout
                  initial={{ opacity: 0, y: 10 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, scale: 0.95 }}
                  className={`bg-card border border-border-subtle p-6 lg:p-7 hover:border-accent/40 transition-all group flex flex-col justify-between min-h-[20rem] relative overflow-hidden ${
                    Date.now() - (room.updatedAt?.toMillis?.() || 0) < 5000 ? 'ring-1 ring-accent ring-inset' : ''
                  }`}
                >
                  {(room.status === 'cleaning' || (selectedRole === 'staff' && room.status === 'available' && room.assignedToday)) && (
                    <div className="absolute left-0 top-0 w-1 h-full bg-accent" />
                  )}
                  
                  <div className="flex justify-between items-start mb-6">
                    <div className="flex flex-col">
                      <span className="font-serif text-3xl font-light group-hover:text-accent transition-colors">
                        {room.roomNumber}
                      </span>
                      <span className="text-[10px] opacity-30 uppercase tracking-widest font-bold mt-1">{room.type} Suite</span>
                    </div>
                    <div className="flex gap-2">
                      {room.status === 'cleaning' && room.lastAction === 'mid_clean' && (
                        <div className="px-2 py-0.5 text-[9px] uppercase tracking-widest font-bold border bg-indigo-500/10 text-indigo-400 border-indigo-500/30">
                          중간청소
                        </div>
                      )}
                      <div className={`px-2 py-0.5 text-[9px] uppercase tracking-widest font-bold border ${statusColors[room.status]}`}>
                        {statusLabels[room.status]}
                      </div>
                    </div>
                  </div>

                  {/* Memo Section */}
                  <div className="mb-4">
                    <div className="flex items-center gap-1.5 mb-1.5 opacity-30">
                      <Edit2 size={10} />
                      <span className="text-[9px] uppercase tracking-widest font-bold">Notes</span>
                    </div>
                    <RoomMemo 
                      room={room}
                      onUpdate={(newMemo) => updateRoomMemo(room, newMemo)}
                    />
                  </div>

                  <div className="space-y-4 lg:space-y-6">
                    <div className="flex flex-col gap-2">
                      <p className="text-[9px] opacity-30 uppercase tracking-widest font-bold">
                        {selectedRole === 'manager' ? 'Reception Operations' : 'Housekeeping Action'}
                      </p>
                      <div className="flex gap-2">
                        {selectedRole === 'manager' ? (
                          room.status !== 'cleaning' ? (
                            <>
                              <button 
                                onClick={() => handleCheckInOut(room, 'clean')}
                                className="flex-1 bg-white/5 border border-white/5 py-4 text-[12px] font-bold uppercase tracking-widest hover:border-accent/30 hover:text-accent transition-all"
                              >
                                청소
                              </button>
                              <button 
                                onClick={() => handleCheckInOut(room, 'mid_clean')}
                                className="flex-1 bg-white/5 border border-white/5 py-4 text-[12px] font-bold uppercase tracking-widest hover:border-accent/30 hover:text-accent transition-all"
                              >
                                중간청소
                              </button>
                            </>
                          ) : (
                            <button 
                              onClick={() => cancelCleaning(room)}
                              className="w-full bg-red-500/10 border border-red-500/20 py-4 text-[12px] font-bold uppercase tracking-widest text-red-400 hover:bg-red-500/20 transition-all"
                            >
                              취소
                            </button>
                          )
                        ) : (
                          <button 
                            onClick={() => updateRoomStatus(room, 'done')}
                            disabled={room.status === 'done' || room.status === 'available'}
                            className="flex-1 bg-emerald-500/10 border border-emerald-500/20 py-4 text-[12px] font-bold uppercase tracking-widest text-[#22C55E] hover:bg-emerald-500/20 transition-all disabled:opacity-20"
                          >
                            청소완료
                          </button>
                        )}
                      </div>
                    </div>
                  </div>
                </motion.div>
              ))
            ) : (
              <div className="col-span-full py-32 text-center border border-dashed border-border-subtle rounded-sm text-slate-500">
                <Bed size={40} className="mx-auto opacity-10 mb-4" />
                <p className="text-[10px] uppercase tracking-[0.3em] opacity-40 px-6">
                  {selectedRole === 'manager' ? 'No data available in current registry' : 'All cleanup tasks completed'}
                </p>
              </div>
            )}
          </AnimatePresence>
        </div>
      </main>
    </div>
  );
}
