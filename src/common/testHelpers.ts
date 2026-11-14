import {readdirSync, readFileSync} from 'node:fs';
import {join} from 'node:path';
import knex from 'knex';

// Applies every SQL migration in supabase/migrations in filename order (V1, V2, ...), mirroring
// what Flyway does against the real schema so tests run against the production schema.
// Assumption: no Flyway binary is available in this repository, so the migration files are
// applied directly via knex instead.
export const runFlywayMigrations = async (connectionString: string): Promise<void> => {
    const db = knex({client: 'pg', connection: connectionString});
    try {
        const dir = join(process.cwd(), 'supabase', 'migrations');
        const files = readdirSync(dir)
            .filter((file) => file.endsWith('.sql'))
            .sort();
        for (const file of files) {
            const migrationSql = readFileSync(join(dir, file), 'utf8');
            await db.raw(migrationSql);
        }
    } finally {
        await db.destroy();
    }
};
