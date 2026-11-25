// Test-only accounts. They exist only in the throwaway database that serve.js creates for each run,
// so the passwords are not secrets.
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ACCOUNTS = {
  admin: { username: 'e2e-admin', display_name: 'E2E Admin', password: 'e2e-admin-pass', role: 'admin' },
  mentor: { username: 'e2e-mentor', display_name: 'E2E Mentor', password: 'e2e-mentor-pass', role: 'mentor' },
  student: { username: 'e2e-student', display_name: 'E2E Student', password: 'e2e-student-pass', role: 'student' },
};

// Saved login state per role, written by global-setup.js and gitignored.
const AUTH_DIR = fileURLToPath(new URL('../.auth/', import.meta.url));
export const authPath = (role) => path.join(AUTH_DIR, `${role}.json`);
