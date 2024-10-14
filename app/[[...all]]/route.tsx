import { auth, signIn } from "@/auth"
import { fsrsHandler } from "../fsrs"
export const dynamic = 'force-dynamic'
export const GET = async (req: Request) => {
    const session = (await auth())
    const uid = session?.user?.id ?? await signIn()
    return fsrsHandler(req, uid)
}
export const POST = async (req: Request) => {
    const session = (await auth())
    const uid = session?.user?.id ?? await signIn()
    return fsrsHandler(req, uid)
}
export const DELETE = async (req: Request) => {
    const session = (await auth())
    const uid = session?.user?.id ?? await signIn()
    return fsrsHandler(req, uid)
}
