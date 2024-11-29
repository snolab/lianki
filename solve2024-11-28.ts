// import { db } from "./schema";
// if (import.meta.main) {
//   console.log(await db.execute(`
//        SELECT
//            constraint_name
//        FROM
//            information_schema.table_constraints
//        WHERE
//            table_name = 'authenticator'
//            `));
// }
/* 

The error you're encountering indicates that there is a problem with the constraints on the `authenticator` table, specifically the primary key constraint `authenticator_userid_credentialid_pk`. This error arises when the database is unable to recognize or find the specified constraint. Let's walk through how to address this issue:

1. **Check the Table Definition in the Database:**
   Make sure that the table `authenticator` and its constraints exist in the database schema as defined in your code. You can inspect the table and its constraints in your database dashboard or by running:
   ```sql
   SELECT
       constraint_name
   FROM
       information_schema.table_constraints
   WHERE
       table_name = 'authenticator';
   ```
   If the table or the constraint is missing, you may need to create or update the table.

2. **Check Migration Scripts:**
   Ensure that any migration scripts used to create the `authenticator` table and its constraints have been run successfully. If you haven't created migration scripts, consider using a tool like Knex, Flyway, or another database migration tool to manage your database schema changes.

3. **Verify Constraint Definition:**
   According to your code, the constraint `authenticator_userid_credentialid_pk` should be a composite primary key for the `userId` and `credentialID` columns. Check that the constraint is defined correctly in your database:
   ```sql
   ALTER TABLE authenticator DROP CONSTRAINT IF EXISTS authenticator_userid_credentialid_pk;

   ALTER TABLE authenticator ADD CONSTRAINT authenticator_userid_credentialid_pk PRIMARY KEY (userId, credentialID);
   ```k

4. **Ensure Unique Keys and Foreign Keys:**
   Beyond the primary key, verify the definitions for any unique keys or foreign keys in the database correspond to your table definitions. Use ALTER statements if necessary to fix any mismatches.

5. **Database Synchronization:**
   If you're using a tool or framework that automatically syncs or updates the database schema, ensure that it's properly configured to handle changes, and rerun the synchronization process to ensure that the latest schema definitions are applied.

6. **Check for Caching Issues:**
   Sometimes, query builders or database clients may cache schema information. Restarting your development server or clearing any relevant caches might resolve certain transient issues.

Once these steps have been followed, try executing your operations again and verify if the problem persists. Accurate schema management and matching code definitions with the database state are crucial for consistency in database operations.
*/
