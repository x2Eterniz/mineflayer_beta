import React, { useState, useEffect, useMemo } from 'react';
import { render, Text, Box, useInput, useApp, Static, Transform } from 'ink';
import chalk from 'chalk';

interface LogEntry {
  id: number;
  content: string;
}

interface AppProps {
  bot: any;
  initialLogs: string[];
  onCommand: (cmd: string) => void;
  onLogAdded: (listener: (log: string) => void) => void;
}

export const App: React.FC<AppProps> = ({ bot, initialLogs, onCommand, onLogAdded }) => {
  const [logs, setLogs] = useState<LogEntry[]>(
    initialLogs.map((l, i) => ({ id: i, content: l }))
  );
  const [input, setInput] = useState('');
  const [status, setStatus] = useState({ health: 20, food: 20, pos: { x: 0, y: 0, z: 0 } });
  const [currentWindow, setCurrentWindow] = useState<any>(null);

  const { exit } = useApp();

  useEffect(() => {
    onLogAdded((newLog) => {
      setLogs((prev) => [...prev.slice(-100), { id: Date.now() + Math.random(), content: newLog }]);
    });

    const interval = setInterval(() => {
      if (bot) {
        setStatus({
          health: bot.health || 0,
          food: bot.food || 0,
          pos: bot.entity?.position || { x: 0, y: 0, z: 0 }
        });
        setCurrentWindow(bot.currentWindow);
      }
    }, 500);

    return () => clearInterval(interval);
  }, [bot, onLogAdded]);

  useInput((inputStr, key) => {
    if (key.return) {
      if (input.trim() === '/quit' || input.trim() === '/exit') {
        exit();
        process.exit(0);
      }
      onCommand(input.trim());
      setInput('');
    } else if (key.backspace || key.delete) {
      setInput((prev) => prev.slice(0, -1));
    } else if (!key.ctrl && !key.meta) {
      setInput((prev) => prev + inputStr);
    }
  });

  const renderWindow = () => {
    if (!currentWindow) return null;
    
    const slots = currentWindow.slots;
    const rows = Math.ceil(slots.length / 9);
    
    return (
      <Box flexDirection="column" borderStyle="round" borderColor="cyan" paddingX={1} marginTop={1}>
        <Text bold color="cyan">{currentWindow.title || 'Window'}</Text>
        <Box flexDirection="column" marginTop={1}>
          {Array.from({ length: rows }).map((_, rowIndex) => (
            <Box key={rowIndex}>
              {Array.from({ length: 9 }).map((_, colIndex) => {
                const slotIndex = rowIndex * 9 + colIndex;
                const item = slots[slotIndex];
                return (
                  <Box 
                    key={colIndex} 
                    borderStyle="single" 
                    borderColor={item ? 'green' : 'gray'}
                    width={5}
                    height={3}
                    alignItems="center"
                    justifyContent="center"
                  >
                    <Text color={item ? 'greenBright' : 'gray'}>
                      {item ? slotIndex.toString().padStart(2, '0') : '  '}
                    </Text>
                  </Box>
                );
              })}
            </Box>
          ))}
        </Box>
        <Text color="gray" dimColor italic>Use /click [slot] to interact</Text>
      </Box>
    );
  };

  return (
    <Box flexDirection="column" height="100%" padding={1}>
      {/* Header */}
      <Box borderStyle="double" borderColor="magenta" paddingX={1} justifyContent="space-between">
        <Box>
          <Text bold color="white">Minecraft Bot </Text>
          <Text color="gray">| </Text>
          <Text color={status.health > 10 ? 'green' : 'red'}>❤ {Math.round(status.health)} </Text>
          <Text color="yellow">🍖 {Math.round(status.food)} </Text>
        </Box>
        <Box>
          <Text color="cyan">XYZ: </Text>
          <Text color="white">
            {Math.round(status.pos.x)}, {Math.round(status.pos.y)}, {Math.round(status.pos.z)}
          </Text>
        </Box>
      </Box>

      {/* Main Content Area */}
      <Box flexDirection="row" flexGrow={1} marginTop={1}>
        {/* Logs */}
        <Box flexDirection="column" flexGrow={1} marginRight={2}>
          <Box flexGrow={1} flexDirection="column">
             {logs.slice(-15).map((log) => (
               <Text key={log.id}>{log.content}</Text>
             ))}
          </Box>
        </Box>

        {/* Sidebar / Window */}
        <Box width={50} flexDirection="column">
          {renderWindow()}
        </Box>
      </Box>

      {/* Input Bar */}
      <Box borderStyle="round" borderColor="blue" paddingX={1} marginTop={1}>
        <Text color="blue" bold> {">"} </Text>
        <Text color="white">{input}</Text>
        <Text color="blue" bold>_</Text>
      </Box>
    </Box>
  );
};
