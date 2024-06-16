// [ Types ] /////////////////////////////////////////////////////////////////////
import { getConfig, RobloxCookie } from "../config"
import { HttpHandler, HttpResponse } from "../http/httpHandler"
//////////////////////////////////////////////////////////////////////////////////


// [ Types ] /////////////////////////////////////////////////////////////////////
import type { IsUnion, UnionPrettify, ObjectPrettify, Falsey } from "typeforge"
import type { RestMethod, SecureUrl } from "../utils/utils.types"

export type ApiMethod<
  RawData, PrettifiedData = undefined,
  PrettifiedDataOrRawData = PrettifiedData extends undefined ? RawData : PrettifiedData,
> = Promise<
  {
    path: `/${string}`,
    method: RestMethod,
    searchParams?: Record<string, any>,
    headers?: Record<string, string | null | undefined>,
    formData?: Record<string, any>,
    body?: any,
    name: string,

    // Hacky workaround to set types for rawData and prettifiedData
    rawData?: RawData,
    prettifiedData?: PrettifiedDataOrRawData,

    getCursorsFn?: (rawData: RawData) => ([ previous: string | number | undefined | null, next: string | number | undefined | null ])
  } &
  (PrettifiedData extends undefined ? {} : { prettifyFn: (rawData: RawData, response: HttpResponse<RawData>) => PrettifiedDataOrRawData })
>

type ApiMethodResult_Pagination<
  Args extends Record<any, any> | undefined,
  RawData, PrettifiedData = RawData,
  Nested extends boolean = false
> = (
  { cursors: PrettifiedCursors } &
  (Nested extends false ? { [Symbol.iterator]: () => {
    next: () => { value: ApiMethodResult<Args, RawData, PrettifiedData, true> }
  } } : {})
)

type ApiMethodResult<
  Args extends Record<any, any> | undefined,
  RawData, PrettifiedData = RawData,
  Nested extends boolean = false
> = ObjectPrettify<(
  {
    data: PrettifiedData,
    response: HttpResponse<RawData>
  } & (
    "cursor" extends keyof Args ? ApiMethodResult_Pagination<Args, RawData, PrettifiedData, Nested>
    : "startRowIndex" extends keyof Args ? ApiMethodResult_Pagination<Args, RawData, PrettifiedData, Nested>
    : {}
  )
)>

type PrettifiedCursors = ObjectPrettify<{
  next?: string,
  previous?: string
}>

export type PrettifyData<Input, _ExtendsDate extends boolean = Input extends Date ? true : false> = (
  _ExtendsDate extends true ? Input
  : Input extends boolean ? boolean
  : Input extends Record<any, any> ? ObjectPrettify<Input>
  : IsUnion<Input> extends true ? UnionPrettify<Input>
  // @ts-ignore | hush hush shawty
  : Array<any> extends Input ? PrettifyData<Input[number]>[]
  : Input extends Array<any> ? PrettifyData<Input[number]>[]
  : Input
)
//////////////////////////////////////////////////////////////////////////////////

// [ Variables ] /////////////////////////////////////////////////////////////////
const config = getConfig()
//////////////////////////////////////////////////////////////////////////////////


// [ Private Functions ] /////////////////////////////////////////////////////////
const formatSearchParams = (params?: Record<string, any>) => {
  if (!params) return ""
  
  const [paramsKeys, paramsValues] = [Object.keys(params), Object.values(params)]
  const formattedParams: { [key: string]:string } = {}

  paramsValues.forEach((param:any, i:number) => {
    if (param == undefined || param == null) return
    if (typeof(param) == "string") return formattedParams[paramsKeys[i] as string] = param
    if (Array.isArray(param)) return formattedParams[paramsKeys[i] as string] = param.join(",")
    if (param instanceof Date) return formattedParams[paramsKeys[i] as string] = param.toDateString()
    return formattedParams[paramsKeys[i] as string] = param.toString()
  })
  
  return `?${new URLSearchParams(formattedParams).toString()}`
}

const defaultGetCursors = (responseBody: Record<any, any>) => {
  return [ responseBody.previousPageCursor, responseBody.nextPageCursor ]
}

function getParams(func:(...args: any[]) => any) {
  let str = func.toString()

  const argsStr = /(?:async) (?:\((?:\{ (.+) \})\))/.exec(str)?.[1]
  if (!argsStr) return []

  return argsStr.replaceAll(/{(.*)}/g, "").replaceAll(/ = ([^,]+)/g, "").replaceAll(/:( *)/g, "").split(", ")
}

const maybeParseInt = (x?: string) => x ? parseInt(x) : x

const getRatelimitMetadata = (headers: Headers) => {
  const limit = headers.get("x-ratelimit-limit")
  const remaining = headers.get("x-ratelimit-remaining")
  const reset = headers.get("x-ratelimit-reset")

  const date = headers.get("date")
  const prettifiedDate = date ? new Date(date) : undefined
  if (prettifiedDate && reset) prettifiedDate.setSeconds(prettifiedDate.getSeconds() + parseInt(reset))

  const limitData = /([0-9]+);w=([0-9]+)/.exec(limit ?? "")

  console.log({
    limit: maybeParseInt(limitData?.[1]),
    window: maybeParseInt(limitData?.[2]),
    remaining: remaining ? parseInt(remaining) : undefined,
    reset: prettifiedDate
  })
}
//////////////////////////////////////////////////////////////////////////////////


type CallApiMethod< Args extends Record<string, any> | undefined, Returns extends ApiMethod<any, any>> = (
  (this: any, args: keyof Args extends undefined ? void : Args) => (
    Promise<ApiMethodResult<
      Args,
      PrettifyData<NonNullable<Awaited<Returns>["rawData"]>>,
      PrettifyData<NonNullable<Awaited<Returns>["prettifiedData"]>>
    >>
  )
)

type CreateApiGroup = (args: { groupName: string, baseUrl: SecureUrl }) => (
  <
    Args extends Record<string, any> | undefined,
    Returns extends ApiMethod<any, any>,
  >(getDataFn: (args: Args) => Returns) => CallApiMethod<Args, Returns>
)

export const createApiGroup: CreateApiGroup = ({ groupName, baseUrl }) => {
  return (getDataFn) => {
    const rawArgs = getParams(getDataFn)
    const rawArgsContainsCursor = (rawArgs.includes("cursor") || rawArgs.includes("startRowIndex")) ? true : false

    const callApiMethod: CallApiMethod<Record<string, any>, ApiMethod<any, any>> = async function (this, args) {
      const overrides = this
      const apiMethodData = await getDataFn(args as any)
      const { path, method, searchParams, headers, body, formData } = apiMethodData

      const url: SecureUrl = `${baseUrl}${path}${formatSearchParams(searchParams)}`

      const response = await HttpHandler({ url, method, headers, body, formData }, {
        cookie: overrides.cookie || config.cookie,
        cloudKey: overrides.cloudKey || config.cloudKey,
        oauthToken: overrides.oauthToken,
      })
      if (!(response instanceof HttpResponse)) throw response // TODO: better error handling
      const responseBody = response.body

      //getRatelimitMetadata(response.headers)

      const prettifyFn = (apiMethodData as any)?.prettifyFn

      const apiMethodResult = {
        response, data: (prettifyFn ? prettifyFn(response.body, response) : response.body)
      }

      if (rawArgsContainsCursor) {
        // Adds cursors to the response if they exist.
        let [ previousCursor, nextCursor ] = (apiMethodData.getCursorsFn ?? defaultGetCursors)(responseBody as Record<any, any>);
        (apiMethodResult as Record<any, any>).cursors = { previous: previousCursor, next: nextCursor } as PrettifiedCursors

        const initialPaginationResult = { ...apiMethodResult };

        // @ts-ignore | hush hush shawty
        (apiMethodResult as Record<any, any>)[Symbol.asyncIterator] = function() {
          let atInitial = true

          return {
            async next() {
              // The initial (already obtained) result.
              if (atInitial) {
                atInitial = false
                return { done: false, value: initialPaginationResult }
              }

              // If there are no more paginated entries.
              if (!nextCursor || nextCursor.length === 0) return { done: true }

              const newValue = await callApiMethod.call(overrides, { ...args, cursor: nextCursor })
              nextCursor = newValue.cursors.next
              return { done: false, value: newValue }
            }
          }
        }
      } 

      return apiMethodResult as any
    }

    return callApiMethod as any
  }
}

type NumberIsLiteral<Num extends number> = (
  number extends Num ? false
  : [Num] extends [never] ? false
  : [Num] extends [string | number] ? true
  : false
)