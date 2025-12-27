// Top-level imports do App
import React, { useState, useEffect, useRef } from 'react';
import { io } from 'socket.io-client';

const socket = io(import.meta.env.VITE_SOCKET_URL || 'http://localhost:3001');
import './styles.css';

function MicIcon({ size = 20 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 3a3 3 0 0 1 3 3v6a3 3 0 0 1-6 0V6a3 3 0 0 1 3-3z" />
      <path d="M19 11a7 7 0 0 1-14 0" />
      <path d="M12 18v4" />
    </svg>
  );
}
function MicOffIcon({ size = 20 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 3a3 3 0 0 1 3 3v6a3 3 0 0 1-6 0V6a3 3 0 0 1 3-3z" />
      <path d="M19 11a7 7 0 0 1-14 0" />
      <path d="M12 18v4" />
      <path d="M2 2l20 20" />
    </svg>
  );
}
function SpeakerIcon({ size = 20 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M6 9H3v6h3l5 4V5L6 9z" />
      <path d="M16 9a5 5 0 0 1 0 6" />
      <path d="M18 7a8 8 0 0 1 0 10" />
    </svg>
  );
}
function SpeakerOffIcon({ size = 20 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M6 9H3v6h3l5 4V5L6 9z" />
      <path d="M2 2l20 20" />
    </svg>
  );
}

function App() {
  const [user, setUser] = useState(null);
  const [view, setView] = useState('login'); // login, lobby, game
  const [room, setRoom] = useState(null);
  const [roomsList, setRoomsList] = useState([]);
  const [showRooms, setShowRooms] = useState(false); // controla exibição das salas
  const [isCreateModalOpen, setIsCreateModalOpen] = useState(false);
  const [newRoomName, setNewRoomName] = useState('');
  const [targetId, setTargetId] = useState(null);
  const [blockRole, setBlockRole] = useState('EMBAIXADOR'); // escolha para bloquear roubo
  const [countdown, setCountdown] = useState(null);
  const [roomName, setRoomName] = useState(''); // nome estável da sala
  const [pendingJoinName, setPendingJoinName] = useState(null); // REMOVER
  const [lossRole, setLossRole] = useState('');
  const [notif, setNotif] = useState('');
  const [exchangeReturn, setExchangeReturn] = useState([]);
  const [audioInEnabled, setAudioInEnabled] = useState(false);
  const [audioOutEnabled, setAudioOutEnabled] = useState(false);
  const localAudioStreamRef = useRef(null);
  const peersRef = useRef({});
  const remoteStreamsRef = useRef({});
  const [remotePeerIds, setRemotePeerIds] = useState([]);
  const roleImg = {
    CONDESSA: 'images/condessa.png',
    ASSASSINO: 'images/assassino.png',
    CAPITAO: 'images/capitao.png',
    DUQUE: 'images/duque.png',
    EMBAIXADOR: 'images/embaixador.png'
  };

  useEffect(() => {
    socket.on('updateRooms', (list) => setRoomsList(list));
    socket.on('roomJoined', (roomData) => {
      setRoom(roomData);
      setRoomName(roomData?.name || '');
      setPendingJoinName(null); // evita rejoin e duplicidade
      setView('game');
    });
    socket.on('gameStateUpdate', (data) => setRoom(data));
    socket.on('notify', (text) => {
      setNotif(text);
      setTimeout(() => setNotif(''), 5000);
    });
    socket.on('error', (msg) => alert(msg));

    return () => {
      socket.off('updateRooms');
      socket.off('roomJoined');
      socket.off('gameStateUpdate');
      socket.off('notify');
      socket.off('error');
    };
  }, []);

  const handleCreateUser = (e) => {
    e.preventDefault();
    setUser({ name: e.target.name.value });
    setView('lobby');
  };

  // Abre/fecha modal de criação e confirma
  const createRoom = () => {
    setNewRoomName('');
    setIsCreateModalOpen(true);
  };

  const closeCreateModal = () => setIsCreateModalOpen(false);

  const confirmCreateRoom = (e) => {
    e?.preventDefault();
    const name = newRoomName.trim();
    if (!name) return;

    // Cria a sala; o servidor já adiciona o host e emite roomJoined
    socket.emit('createRoom', { roomName: name, userName: user?.name });
    setIsCreateModalOpen(false);
  };

  // Quando a sala criada aparecer no updateRooms, entra automaticamente
  // useEffect de auto-join quando a sala aparece na lista — REMOVER
  // useEffect(() => {
  //   if (pendingJoinName && roomsList.some(r => r.name === pendingJoinName)) {
  //     socket.emit('joinRoom', { roomName: pendingJoinName, userName: user?.name });
  //     setPendingJoinName(null);
  //   }
  // }, [pendingJoinName, roomsList, user?.name]);

  // Fecha com ESC
  useEffect(() => {
    const handler = (e) => e.key === 'Escape' && setIsCreateModalOpen(false);
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, []);

  // Derivados de turno
  const currentPlayer = room?.players?.[room?.turnIndex] || null;
  const isMyTurn = !!currentPlayer && currentPlayer.id === socket.id;
  const isMyLossChoice =
    room?.pendingAction?.type === 'loss_choice' &&
    room?.pendingAction?.actorId === socket.id;
  const isMyTaxPending =
    room?.pendingAction?.type === 'tax' &&
    room?.pendingAction?.actorId === socket.id;
  const isMyStealPending =
    room?.pendingAction?.type === 'steal' &&
    room?.pendingAction?.actorId === socket.id;
  const isMyAssassinatePending =
    room?.pendingAction?.type === 'assassinate' &&
    room?.pendingAction?.actorId === socket.id;
  const isMyForeignAidPending =
    room?.pendingAction?.type === 'foreign_aid' &&
    room?.pendingAction?.actorId === socket.id;
  const isMyExchangePending =
    room?.pendingAction?.type === 'exchange' &&
    room?.pendingAction?.actorId === socket.id;
  const isMyExchangeChoicePending =
    room?.pendingAction?.type === 'exchange_choice' &&
    room?.pendingAction?.actorId === socket.id;
  const iPermitted =
    Array.isArray(room?.pendingAction?.agreements) &&
    room?.pendingAction?.agreements.includes(socket.id);
  const canShowActionControls =
    isMyTurn &&
    !isMyLossChoice &&
    room?.pendingAction?.type !== 'loss_choice' &&
    !isMyTaxPending &&
    !isMyStealPending &&
    !isMyAssassinatePending &&
    !isMyForeignAidPending &&
    !isMyExchangePending &&
    !isMyExchangeChoicePending;

  // Ações simples (executadas direto no servidor)
  const performAction = (action) => {
    if (!roomName) {
      console.log('performAction abortado: roomName vazio');
      return;
    }
    console.log('emit performAction', { roomName, action, targetId });
    socket.emit('performAction', { roomName, action, targetId });
  };

  // Fluxo de ações declaradas (desafio/bloqueio/finalização)
  const declareAction = (action) => {
    if (!roomName) {
      console.log('declareAction abortado: roomName vazio');
      return;
    }
    console.log('emit declareAction', { roomName, action, targetId });
    socket.emit('declareAction', { roomName, action, targetId });
  };
  const finalizeAction = () => {
    if (!roomName) return;
    console.log('emit finalizeAction', { roomName });
    socket.emit('finalizeAction', { roomName });
  };
  const challengeAction = () => {
    if (!roomName) return;
    console.log('emit challengeAction', { roomName });
    socket.emit('challengeAction', { roomName });
  };
  const blockAction = () => {
    if (!roomName) return;
    console.log('emit blockAction', { roomName, role: blockRole });
    socket.emit('blockAction', { roomName, role: blockRole });
  };
  const challengeBlock = () => {
    if (!roomName) return;
    console.log('emit challengeBlock', { roomName });
    socket.emit('challengeBlock', { roomName });
  };
  const permitAction = () => {
    if (!roomName) return;
    console.log('emit permitAction', { roomName });
    socket.emit('permitAction', { roomName });
  };
  const cancelPending = () => {
    if (!roomName) return;
    console.log('emit cancelAction', { roomName });
    socket.emit('cancelAction', { roomName });
  };
  const chooseLossCard = () => {
    if (!roomName || !lossRole) return;
    console.log('emit chooseLossCard', { roomName, role: lossRole });
    socket.emit('chooseLossCard', { roomName, role: lossRole });
  };
  const toggleExchangePick = (i) => {
    setExchangeReturn((prev) => {
      const has = prev.includes(i);
      if (has) return prev.filter(x => x !== i);
      if (prev.length >= 2) return prev;
      return [...prev, i];
    });
  };
  const submitExchangeReturn = () => {
    if (!roomName || exchangeReturn.length !== 2) return;
    const pool = room?.pendingAction?.pool || [];
    const roles = exchangeReturn.map((idx) => pool[idx]);
    socket.emit('chooseExchangeReturn', { roomName, roles });
    setExchangeReturn([]);
  };

  useEffect(() => {
    const pa = room?.pendingAction;
    const enable = !!pa && ['foreign_aid', 'assassinate', 'tax', 'exchange'].includes(pa.type) && !pa.block && pa.expiresAt;
    if (enable) {
      const tick = () => {
        const ms = pa.expiresAt - Date.now();
        setCountdown(ms > 0 ? Math.ceil(ms / 1000) : 0);
      };
      tick();
      const id = setInterval(tick, 500);
      return () => clearInterval(id);
    } else {
      setCountdown(null);
    }
  }, [room?.pendingAction]);

  // Define uma carta padrão para descarte quando entrar em loss_choice
  useEffect(() => {
    const pa = room?.pendingAction;
    if (pa?.type === 'loss_choice' && pa.actorId === socket.id) {
      const myCards = room?.players?.find(p => p.id === socket.id)?.cards || [];
      setLossRole(myCards[0] || '');
    } else {
      setLossRole('');
    }
  }, [room?.pendingAction, room?.players]);

  const setupPeer = (peerId) => {
    if (peersRef.current[peerId]) return peersRef.current[peerId];
    const pc = new RTCPeerConnection({ iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] });
    pc.onicecandidate = (e) => {
      if (e.candidate && roomName) {
        socket.emit('rtcCandidate', { roomName, targetId: peerId, candidate: e.candidate });
      }
    };
    pc.ontrack = (e) => {
      remoteStreamsRef.current[peerId] = e.streams[0];
      setRemotePeerIds(Object.keys(remoteStreamsRef.current));
    };
    peersRef.current[peerId] = pc;
    return pc;
  };

  const startMic = async () => {
    if (audioInEnabled) return;
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      localAudioStreamRef.current = stream;
      setAudioInEnabled(true);
      const others = (room?.players || []).map(p => p.id).filter(id => id !== socket.id);
      for (const id of others) {
        const pc = setupPeer(id);
        stream.getTracks().forEach(track => pc.addTrack(track, stream));
        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);
        socket.emit('rtcOffer', { roomName, targetId: id, sdp: offer });
      }
    } catch (err) {
      alert('Falha ao acessar microfone');
    }
  };

  const stopMic = () => {
    const stream = localAudioStreamRef.current;
    if (stream) {
      stream.getTracks().forEach(t => t.stop());
      localAudioStreamRef.current = null;
    }
    setAudioInEnabled(false);
    if (roomName) socket.emit('rtcEnd', { roomName });
    Object.values(peersRef.current).forEach(pc => {
      pc.getSenders().forEach(s => {
        if (s.track && s.track.kind === 'audio' && s.track.stop) s.track.stop();
      });
    });
  };

  useEffect(() => {
    const onOffer = async ({ fromId, sdp }) => {
      const pc = setupPeer(fromId);
      await pc.setRemoteDescription(new RTCSessionDescription(sdp));
      const stream = localAudioStreamRef.current;
      if (audioInEnabled && stream) {
        stream.getTracks().forEach(track => pc.addTrack(track, stream));
      }
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      socket.emit('rtcAnswer', { roomName, targetId: fromId, sdp: answer });
    };
    const onAnswer = async ({ fromId, sdp }) => {
      const pc = setupPeer(fromId);
      await pc.setRemoteDescription(new RTCSessionDescription(sdp));
    };
    const onCandidate = async ({ fromId, candidate }) => {
      const pc = setupPeer(fromId);
      try {
        await pc.addIceCandidate(new RTCIceCandidate(candidate));
      } catch {}
    };
    const onPeerLeft = ({ peerId }) => {
      const pc = peersRef.current[peerId];
      if (pc) {
        pc.close();
        delete peersRef.current[peerId];
      }
      delete remoteStreamsRef.current[peerId];
      setRemotePeerIds(Object.keys(remoteStreamsRef.current));
    };
    socket.on('rtcOffer', onOffer);
    socket.on('rtcAnswer', onAnswer);
    socket.on('rtcCandidate', onCandidate);
    socket.on('rtcPeerLeft', onPeerLeft);
    return () => {
      socket.off('rtcOffer', onOffer);
      socket.off('rtcAnswer', onAnswer);
      socket.off('rtcCandidate', onCandidate);
      socket.off('rtcPeerLeft', onPeerLeft);
    };
  }, [roomName, audioInEnabled]);

  if (view === 'login') {
    return (
      <div className="page bg-cover">
        <div className="card">
          <div className="brand">
            <div className="brand-title">Coup</div>
          </div>
          <h1 className="title login-title">Login</h1>
          <form className="form" onSubmit={handleCreateUser}>
            <input
              className="input"
              name="name"
              placeholder="Nome do usuário"
              required
            />
            <button className="button" type="submit">Entrar</button>
          </form>
        </div>
      </div>
    );
  }

  if (view === 'lobby') {
    return (
      <div className="page bg-cover">
        <div className="card">
          <h1 className="title">Bem-vindo, {user?.name}</h1>

          <div className="toolbar">
            <button className="button" onClick={createRoom}>Criar Sala</button>
            <button
              className="button outline"
              onClick={() => setShowRooms(prev => !prev)}
            >
              {showRooms ? 'Ocultar Salas Disponíveis' : 'Ver Salas Disponíveis'}
            </button>
          </div>

          {showRooms && (
            <div className="rooms-panel">
              <h2 className="panel-title">Salas Disponíveis</h2>

              {roomsList.length === 0 ? (
                <p className="muted">Nenhuma sala ativa no momento.</p>
              ) : (
                roomsList.map(r => (
                  <div key={r.name} className="room-item">
                    <span className="room-name">{r.name}</span>
                    <button
                      className="secondary-button"
                      onClick={() =>
                        socket.emit('joinRoom', {
                          roomName: r.name,
                          userName: user?.name
                        })
                      }
                    >
                      Entrar
                    </button>
                  </div>
                ))
              )}
            </div>
          )}

          {isCreateModalOpen && (
            <div className="modal-overlay" onClick={closeCreateModal}>
              <div className="modal" onClick={(e) => e.stopPropagation()}>
                <h2 className="modal-title">Criar Sala</h2>
                <form className="modal-form" onSubmit={confirmCreateRoom}>
                  <input
                    className="input"
                    placeholder="Nome da sala"
                    value={newRoomName}
                    onChange={(e) => setNewRoomName(e.target.value)}
                    autoFocus
                  />
                  <div className="modal-actions">
                    <button
                      type="button"
                      className="secondary-button outline"
                      onClick={closeCreateModal}
                    >
                      Cancelar
                    </button>
                    <button type="submit" className="button">
                      Criar
                    </button>
                  </div>
                </form>
              </div>
            </div>
          )}
        </div>
      </div>
    );
  }

  // View de jogo (game)
  return (
    <div className="page">
      {room?.starting && (
        <div className="start-overlay">
          <div className="start-content">
            <div className="start-count">{room?.startingCountdown || 3}</div>
            <div className="start-label">Iniciando o jogo</div>
          </div>
        </div>
      )}
      <div className="card game-card">
        <div className="game-header">
          <h1 className="title">Sala: {roomName || room?.name}</h1>
          {!room?.gameStarted && room?.winnerId && (
            <div className="hint">Vencedor: {room.players.find(p => p.id === room.winnerId)?.name}</div>
          )}
          {!room?.gameStarted && room?.host === socket.id && (
            <button
              className="button start-button"
              onClick={() => socket.emit('startGame', roomName)}
              disabled={(room?.players?.length || 0) < 2}
            >
              Iniciar Jogo
            </button>
          )}
        </div>

        {room?.gameStarted && (
          <div className="actions-bar">
            <div className="turn-hint">
              {isMyTurn ? 'Sua vez' : `Vez de: ${currentPlayer?.name || ''}`}
            </div>
            {notif && <div className="notify">{notif}</div>}
            <div className="toolbar">
              <button
                className={`secondary-button ${audioInEnabled ? 'outline' : ''}`}
                onClick={audioInEnabled ? stopMic : startMic}
                aria-label={audioInEnabled ? 'Desativar Microfone' : 'Ativar Microfone'}
                title={audioInEnabled ? 'Desativar Microfone' : 'Ativar Microfone'}
              >
                {audioInEnabled ? <MicIcon /> : <MicOffIcon />}
              </button>
              <button
                className="secondary-button"
                onClick={() => setAudioOutEnabled(prev => !prev)}
                aria-label={audioOutEnabled ? 'Desativar Saída de Áudio' : 'Ativar Saída de Áudio'}
                title={audioOutEnabled ? 'Desativar Saída de Áudio' : 'Ativar Saída de Áudio'}
              >
                {audioOutEnabled ? <SpeakerIcon /> : <SpeakerOffIcon />}
              </button>
            </div>
            {canShowActionControls && (
              <>
                <div className="target-row">
                  <select
                    className="target-select"
                    value={targetId || ''}
                    onChange={(e) => setTargetId(e.target.value || null)}
                  >
                    <option value="">Selecionar alvo</option>
                    {room?.players
                      .filter(p => p.id !== socket.id)
                      .map(p => (
                        <option key={p.id} value={p.id}>{p.name}</option>
                      ))}
                  </select>
                </div>
                <div className="actions-col">
                  <div className="actions-heading">AÇÃO DO JOGO</div>
                  <button
                    className="button"
                    onClick={() => performAction('income')}
                    disabled={room?.players?.find(p => p.id === socket.id)?.coins >= 10}
                  >
                    Renda (+1)
                  </button>
                  <button
                    className="button outline"
                    onClick={() => declareAction('foreign_aid')}
                    disabled={room?.players?.find(p => p.id === socket.id)?.coins >= 10}
                  >
                    Ajuda Externa (+2)
                  </button>
                  <button
                    className="secondary-button"
                    onClick={() => performAction('coup')}
                    disabled={
                      !targetId ||
                      (room?.players?.find(p => p.id === socket.id)?.coins || 0) < 7
                    }
                  >
                    Golpe de Estado (7)
                  </button>
                </div>
                <div className="actions-col">
                  <div className="actions-heading">AÇÃO DO PERSONAGEM</div>
                  <button
                    className="button"
                    onClick={() => declareAction('tax')}
                    disabled={
                      room?.players?.find(p => p.id === socket.id)?.coins >= 10
                    }
                  >
                    Receber 3 Moedas
                  </button>
                  <button
                    className="secondary-button"
                    onClick={() => declareAction('steal')}
                    disabled={
                      !targetId ||
                      ((room?.players?.find(p => p.id === targetId)?.coins || 0) < 2) ||
                      room?.players?.find(p => p.id === socket.id)?.coins >= 10
                    }
                  >
                    Extorquir 2 Moedas
                  </button>
                  <button
                    className="secondary-button"
                    onClick={() => declareAction('assassinate')}
                    disabled={
                      (room?.players?.find(p => p.id === socket.id)?.coins || 0) < 3 ||
                      !targetId ||
                      room?.players?.find(p => p.id === socket.id)?.coins >= 10
                    }
                  >
                    Assassinar (3)
                  </button>
                  <button
                    className="button outline"
                    onClick={() => declareAction('exchange')}
                    disabled={room?.players?.find(p => p.id === socket.id)?.coins >= 10}
                  >
                    Trocar Cartas
                  </button>
                </div>
                {room?.players?.find(p => p.id === socket.id)?.coins >= 10 && (
                  <div className="hint">Com 10+ moedas, somente Golpe de Estado é permitido.</div>
                )}
              </>
            )}
            {/* Painel de pendência: desafio/bloqueio/finalização */}
            {room?.pendingAction && (
              <div className="pending-panel">
                <div className="pending-title">
                  Ação pendente: {room.pendingAction.type === 'assassinate' && 'Assassinar'}
                  {room.pendingAction.type === 'steal' && 'Roubar'}
                  {room.pendingAction.type === 'exchange' && 'Trocar'}
                  {room.pendingAction.type === 'exchange_choice' && 'Trocar Cartas'}
                  {room.pendingAction.type === 'tax' && 'Receber 3 Moedas'}
                  {room.pendingAction.type === 'foreign_aid' && 'Ajuda Externa'}
                </div>
                <div className="pending-body">
                  <span>
                    Ator: {room.players.find(p => p.id === room.pendingAction.actorId)?.name}
                  </span>
                  {['foreign_aid','assassinate','tax','exchange'].includes(room.pendingAction.type) && !room.pendingAction.block && countdown !== null && (
                    <div className="countdown-circle">{countdown}</div>
                  )}
                </div>

                {/* Ajuda Externa: qualquer não-ator pode Bloquear ou Permitir */}
                {room.pendingAction.type === 'foreign_aid' && room.pendingAction.actorId !== socket.id && !room.pendingAction.block && (
                  <div className="block-controls">
                    {!iPermitted && (
                      <button className="secondary-button" onClick={permitAction}>Permitir</button>
                    )}
                    <button
                      className="secondary-button"
                      onClick={() => socket.emit('blockAction', { roomName, role: 'DUQUE' })}
                    >
                      Bloquear (DUQUE)
                    </button>
                    {iPermitted && (
                      <span className="muted">Você permitiu. Aguardando os demais jogadores…</span>
                    )}
                  </div>
                )}
                {/* Roubar: qualquer não-ator pode Permitir ou Bloquear */}
                {room.pendingAction.type === 'steal' && room.pendingAction.actorId !== socket.id && !room.pendingAction.block && (
                  <div className="block-controls">
                    {!iPermitted && (
                      <button className="secondary-button" onClick={permitAction}>Permitir</button>
                    )}
                    <button
                      className="secondary-button"
                      onClick={() => socket.emit('blockAction', { roomName, role: 'STEAL_BLOCK' })}
                    >
                      Bloquear
                    </button>
                    {iPermitted && (
                      <span className="muted">Você permitiu. Aguardando os demais jogadores…</span>
                    )}
                  </div>
                )}

                {/* Bloqueio declarado: ator decide contestar ou cancelar (Ajuda Externa ou Roubar) */}
                {['foreign_aid','steal'].includes(room.pendingAction.type) && room.pendingAction.block && room.pendingAction.actorId === socket.id && (
                  <div className="challenge-row">
                    <span className="muted">
                      Bloqueio por {room.players.find(p => p.id === room.pendingAction.block.blockerId)?.name}.
                    </span>
                    <button className="button outline" onClick={challengeBlock}>Contestar</button>
                    <button className="secondary-button" onClick={cancelPending}>Cancelar Ação</button>
                  </div>
                )}
                {room.pendingAction.type === 'assassinate' && room.pendingAction.block && room.pendingAction.actorId === socket.id && (
                  <div className="challenge-row">
                    <span className="muted">
                      Bloqueio por {room.players.find(p => p.id === room.pendingAction.block.blockerId)?.name} como CONDESSA.
                    </span>
                    <button className="button outline" onClick={challengeBlock}>Contestar</button>
                    <button className="secondary-button" onClick={cancelPending}>Cancelar Ação</button>
                  </div>
                )}

                {room.pendingAction.type === 'loss_choice' && room.pendingAction.actorId === socket.id && (
                  <div className="challenge-row">
                    <span className="muted">Escolha uma carta para descartar:</span>
                    <select
                      className="target-select"
                      value={lossRole}
                      onChange={(e) => setLossRole(e.target.value)}
                    >
                      {(room.players.find(p => p.id === socket.id)?.cards || []).map((c, i) => (
                        <option key={i} value={c}>{c}</option>
                      ))}
                    </select>
                    <button className="button" onClick={chooseLossCard}>Confirmar Escolha</button>
                  </div>
                )}
                {room.pendingAction.type === 'exchange_choice' && room.pendingAction.actorId === socket.id && (
                  <div className="challenge-row">
                    <span className="muted">Escolha 2 cartas para devolver ao baralho:</span>
                    <div className="card-images">
                      {(room.pendingAction.pool || []).map((c, i) => (
                        <img
                          key={`pool-${c}-${i}`}
                          className={`role-img ${exchangeReturn.includes(i) ? 'selected' : ''}`}
                          src={roleImg[c] || ''}
                          alt={c}
                          onClick={() => toggleExchangePick(i)}
                        />
                      ))}
                    </div>
                    <button className="button" onClick={submitExchangeReturn} disabled={exchangeReturn.length !== 2}>
                      Confirmar Devolução
                    </button>
                  </div>
                )}

                {/* Assassinar: alvo pode Bloquear (some após bloqueio) */}
                {room.pendingAction.type === 'assassinate' &&
                  room.pendingAction.targetId === socket.id &&
                  !room.pendingAction.block && (
                  <div className="block-controls">
                    <button
                      className="secondary-button"
                      onClick={() => socket.emit('blockAction', { roomName, role: 'CONDESSA' })}
                    >
                      Bloquear
                    </button>
                    <button className="button outline" onClick={permitAction}>
                      Aceitar
                    </button>
                  </div>
                )}
                {/* Demais ações com bloqueio do alvo (exclui Roubar e Assassinar) */}
                {room.pendingAction.type !== 'exchange' &&
                  room.pendingAction.type !== 'steal' &&
                  room.pendingAction.type !== 'assassinate' &&
                  room.pendingAction.targetId === socket.id && (
                  <div className="block-controls">
                    <label className="muted">Bloquear como:</label>
                    <select
                      className="target-select"
                      value={blockRole}
                      onChange={(e) => setBlockRole(e.target.value)}
                    >
                      <option value="EMBAIXADOR">EMBAIXADOR</option>
                      <option value="CAPITAO">CAPITAO</option>
                    </select>
                    <button className="secondary-button" onClick={blockAction}>
                      Bloquear
                    </button>
                  </div>
                )}

                {/* Qualquer não-ator pode contestar ações que suportam contestação */}
                {room.pendingAction.actorId !== socket.id &&
                  (room.pendingAction.type !== 'assassinate' || room.pendingAction.targetId !== socket.id) &&
                  ['assassinate','exchange','tax'].includes(room.pendingAction.type) && (
                  <button className="button outline" onClick={challengeAction}>
                    Contestar Ação
                  </button>
                )}
                {/* Permitir explicitamente: Tax e Exchange */}
                {['tax','exchange'].includes(room.pendingAction.type) &&
                  room.pendingAction.actorId !== socket.id &&
                  !iPermitted && (
                    <button className="secondary-button" onClick={permitAction}>
                      Permitir
                    </button>
                  )}
                {['tax','exchange'].includes(room.pendingAction.type) &&
                  room.pendingAction.actorId !== socket.id &&
                  iPermitted && (
                    <span className="muted">Você permitiu. Aguardando os demais jogadores…</span>
                  )}

                {/* Ator confirma execução apenas para ações que não sejam Ajuda Externa, Tax, Roubar, Assassinar, Trocar Cartas, Escolha de Troca ou Loss Choice */}
                {room.pendingAction.actorId === socket.id &&
                  !room.pendingAction.block &&
                  !['foreign_aid','tax','steal','assassinate','exchange','exchange_choice','loss_choice'].includes(room.pendingAction.type) && (
                  <button className="button" onClick={finalizeAction}>
                    Confirmar Execução
                  </button>
                )}
              </div>
            )}
          </div>
        )}

        <div style={{ display: 'none' }}>
          {remotePeerIds.map(id => (
            <audio
              key={id}
              autoPlay
              muted={!audioOutEnabled}
              ref={el => {
                if (el && remoteStreamsRef.current[id]) {
                  el.srcObject = remoteStreamsRef.current[id];
                }
              }}
            />
          ))}
        </div>
        <div className="players-grid">
          {room?.players.map(p => (
            <div key={p.id} className={`player-card ${p.id === socket.id ? 'me' : ''}`}>
              <div className="player-header">
                <span className="player-name">{p.name}</span>
                {p.id === socket.id && <span className="badge">Você</span>}
              </div>
              <div className="player-info">
                <span className="coins">Moedas: {p.coins}</span>
                {p.id === socket.id ? (
                  <>
                    <div className="cards">Minhas Cartas</div>
                    <div className="card-images">
                      {(p.cards || []).map((c, i) => (
                        <img key={`${c}-${i}`} className="role-img" src={roleImg[c] || ''} alt={c} />
                      ))}
                    </div>
                    {(p.lostReveals && p.lostReveals.length > 0) && (
                      <>
                        <div className="cards">Cartas Reveladas</div>
                        <div className="card-images">
                          {p.lostReveals.map((c, i) => (
                            <img key={`lost-${c}-${i}`} className="role-img" src={roleImg[c] || ''} alt={c} />
                          ))}
                        </div>
                      </>
                    )}
                  </>
                ) : (
                  <>
                    <div className="cards">Cartas do Jogador</div>
                    <div className="card-images">
                      {Array.from({ length: (p.cards || []).length }).map((_, i) => (
                        <img key={`back-${p.id}-${i}`} className="role-img" src="images/verso.png" alt="Verso da carta" />
                      ))}
                      {(p.lostReveals || []).map((c, i) => (
                        <img key={`lost-${p.id}-${i}`} className="role-img" src={roleImg[c] || ''} alt={c} />
                      ))}
                    </div>
                  </>
                )}
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

export default App;
