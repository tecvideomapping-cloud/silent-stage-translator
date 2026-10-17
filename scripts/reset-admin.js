/**
 * Script utilitário para verificar ou redefinir as credenciais do Administrador
 * Uso:
 *   node scripts/reset-admin.js
 *   node scripts/reset-admin.js novo_email@videomappingtech.com NovaSenha123!
 */
require('dotenv').config();
const { Pool } = require('pg');
const { hashPassword } = require('../server/auth');

async function main() {
  const targetEmail = (process.argv[2] || process.env.ADMIN_EMAIL || 'admin@videomappingtech.com').toLowerCase().trim();
  const targetPass = process.argv[3] || process.env.ADMIN_PASSWORD || 'Videomapping2026!';

  console.log('---------------------------------------------------------');
  console.log('🔑 SILENT STAGE AI - GERENCIADOR DE ACESSO ADMINISTRATIVO');
  console.log('---------------------------------------------------------');

  if (process.env.DATABASE_URL) {
    console.log('[PostgreSQL] Conectando ao banco de dados...');
    const pool = new Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
    });

    try {
      const hashed = hashPassword(targetPass);
      const res = await pool.query(
        `INSERT INTO users (email, password_hash, password_salt, name, role)
         VALUES ($1, $2, $3, 'Administrador Videomappingtech', 'superadmin')
         ON CONFLICT (email) 
         DO UPDATE SET password_hash = $2, password_salt = $3, role = 'superadmin'
         RETURNING id, email, role`,
        [targetEmail, hashed.hash, hashed.salt]
      );

      console.log('✓ Senha atualizada no banco de dados com sucesso!');
      console.log(`  E-mail: ${res.rows[0].email}`);
      console.log(`  Senha:  ${targetPass}`);
      console.log(`  Perfil: ${res.rows[0].role}`);
      await pool.end();
    } catch (err) {
      console.error('Erro ao acessar PostgreSQL:', err.message);
    }
  } else {
    console.log('[Modo In-Memory / Local]');
    console.log('O servidor está operando com armazenamento local (sem DATABASE_URL).');
    console.log('As credenciais padrão ativas são:');
    console.log(`  E-mail: ${targetEmail}`);
    console.log(`  Senha:  ${targetPass}`);
    console.log('');
    console.log('Para definir uma senha personalizada de forma permanente, crie um arquivo .env contendo:');
    console.log(`  ADMIN_EMAIL=${targetEmail}`);
    console.log(`  ADMIN_PASSWORD=${targetPass}`);
  }

  console.log('---------------------------------------------------------');
  console.log('Página de Login: http://localhost:3000/login.html');
  console.log('---------------------------------------------------------');
}

main().catch(console.error);
