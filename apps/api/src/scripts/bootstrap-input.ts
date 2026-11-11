import { bootstrapAdminSchema } from '../auth/schemas.js';

type BootstrapField = 'username' | 'displayName' | 'phone' | 'email' | 'password';
type BootstrapPrompt = {
  interactive: boolean;
  read: (question: string, hidden: boolean) => Promise<string>;
  write: (message: string) => void;
};

const validationMessages: Record<BootstrapField, string> = {
  username: 'El nombre de usuario debe tener entre 3 y 100 caracteres y usar solo letras, números, punto, guion o guion bajo.',
  displayName: 'El nombre visible debe tener entre 1 y 150 caracteres.',
  phone: 'El teléfono debe tener entre 7 y 40 caracteres y usar solo números, espacios, +, paréntesis, punto o guion.',
  email: 'Ingresa un email válido de hasta 255 caracteres.',
  password: 'La contraseña debe tener entre 12 y 128 caracteres e incluir al menos una letra y un número.'
};

export async function collectBootstrapInput(prompt: BootstrapPrompt) {
  async function readField(field: BootstrapField, question: string, hidden = false): Promise<string> {
    while (true) {
      const value = await prompt.read(question, hidden);
      const parsed = bootstrapAdminSchema.shape[field].safeParse(value);
      if (parsed.success) return parsed.data;
      const message = validationMessages[field];
      if (!prompt.interactive) throw new Error(message);
      prompt.write(`Error: ${message}\nVuelve a ingresar este dato.\n`);
    }
  }

  const username = await readField('username', 'Nombre de usuario:');
  const displayName = await readField('displayName', 'Nombre visible:');
  const phone = await readField('phone', 'Teléfono:');
  const email = await readField('email', 'Email:');
  prompt.write(`${validationMessages.password}\n`);
  const password = await readField('password', 'Contraseña:', true);

  while (true) {
    const confirmation = await prompt.read('Confirma la contraseña:', true);
    if (confirmation === password) break;
    const message = 'Las contraseñas no coinciden.';
    if (!prompt.interactive) throw new Error(message);
    prompt.write(`Error: ${message}\nVuelve a ingresar la confirmación.\n`);
  }

  return bootstrapAdminSchema.parse({ username, displayName, phone, email, password, role: 'JEFE' });
}
