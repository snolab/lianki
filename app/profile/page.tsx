// 1. create password

import { signIn } from "@/auth"
import { authUser } from "../signInEmail"

// 2. link oauth
export default async function ProfilePage() {
    // 
    // /onborarding/step1-create-password
    // /onborarding/step2-link-oauth
    // /onborarding/step3-tutorial
    const user = await authUser()
    return <>
        Email: {user.email}
        {JSON.stringify(user)}

        <form action={async (data) => {
            'use server'
            await signIn('nodemailer', data)
        }}>
            <input name='email' type='email' />
            <button>Link Email</button>
        </form>

        {/* todo: show areadly linked github account and goto it */}
        <form action={async () => {
            'use server'
            // const user = await authUser()
            await signIn('github')
            // await db.select("*").from(accounts).where(eq(accounts.userId, user.id))
        }}>
            <button>Link Github</button>
        </form>

        <form action={
            async () => {
                'use server'
                // const user = await authUser()

                // user.password
            }}>
            Password: {user.password ? '***' : 'No Password yet'}
            <input type='password' name='password' />
            <input type='password' name='confirm-password' />
            <button>Update Password</button>
        </form>
    </>
}