import { debug } from "../../debug"
import * as node_fetch from "node-fetch"
import { Agent } from "http"
import HttpsProxyAgent from "https-proxy-agent"
import v from "voca"

import {
  GitlabPRDSL,
  GitlabCommit,
  GitlabPRComment,
  JIRAIssue,
  GitlabPRActivity,
  GitlabDiff,
  RepoMetaData,
  GitlabChanges,
  GitlabChangesValue,
} from "../../dsl/GitlabDSL"
import { Comment } from "../platform"

import { Env } from "../../ci_source/ci_source"
import { dangerSignaturePostfix, dangerIDToString } from "../../runner/templates/gitlabTemplate"
import { api as fetch } from "../../api/fetch"

// Note that there are parts of this class which don't seem to be
// used by Danger, they are exposed for Peril support.

export interface GitlabRepoCredentials {
  host: string
  username?: string
  password?: string
  token?: string
}

export function bitbucketServerRepoCredentialsFromEnv(env: Env): GitlabRepoCredentials {
  if (!env["DANGER_GITLAB_HOST"]) {
    throw new Error(`DANGER_GITLAB_HOST is not set`)
  }
  return {
    host: env["DANGER_GITLAB_HOST"],
    username: env["DANGER_GITLAB_USERNAME"],
    password: env["DANGER_GITLAB_PASSWORD"],
    token: env["DANGER_GITLAB_TOKEN"],
  }
}

/** This represent the Gitlab API */

export class GitlabAPI {
  fetch: typeof fetch
  private readonly d = debug("GitlabAPI")

  private pr: GitlabPRDSL | undefined

  constructor(public readonly repoMetadata: RepoMetaData, public readonly repoCredentials: GitlabRepoCredentials) {
    // This allows Peril to DI in a new Fetch function
    // which can handle unique API edge-cases around integrations
    this.fetch = fetch
  }

  getPRBasePath() {
    const { repoSlug, pullRequestID } = this.repoMetadata
    return `/projects/${repoSlug}/merge_requests/${pullRequestID}`
  }

  getPullRequestInfo = async (): Promise<GitlabPRDSL> => {
    if (this.pr) {
      return this.pr
    }
    const path = this.getPRBasePath()
    const res = await this.get(path)
    throwIfNotOk(res)
    const prDSL = (await res.json()) as GitlabPRDSL
    this.pr = prDSL
    return prDSL
  }

  getPullRequestCommits = async (): Promise<GitlabCommit[]> => {
    const path = `${this.getPRBasePath()}/commits`
    const res = await this.get(path)
    throwIfNotOk(res)
    return (await res.json()).values
  }

  getStructuredDiffForFile = async (base: string, head: string, filename: string): Promise<GitlabDiff[]> => {
    const { repoSlug } = this.repoMetadata
    const path = `rest/api/1.0/${repoSlug}/compare/diff/${filename}?withComments=false&from=${base}&to=${head}`
    const res = await this.get(path)
    throwIfNotOk(res)
    return (await res.json()).diffs
  }

  getPullRequestChanges = async (): Promise<GitlabChangesValue[]> => {
    let nextPageStart: null | number = 0
    let values: GitlabChangesValue[] = []

    do {
      const path = `${this.getPRBasePath()}/changes?start=${nextPageStart}`
      const res = await this.get(path)
      throwIfNotOk(res)

      const data = (await res.json()) as GitlabChanges

      values = values.concat(data.values)
      nextPageStart = data.nextPageStart
    } while (nextPageStart !== null)

    return values
  }

  getPullRequestComments = async (): Promise<GitlabPRActivity[]> => {
    const path = `${this.getPRBasePath()}/activities?fromType=COMMENT`
    const res = await this.get(path)
    throwIfNotOk(res)
    return (await res.json()).values
  }

  getPullRequestActivities = async (): Promise<GitlabPRActivity[]> => {
    const path = `${this.getPRBasePath()}/activities?fromType=ACTIVITY`
    const res = await this.get(path)
    throwIfNotOk(res)
    return (await res.json()).values
  }

  getIssues = async (): Promise<JIRAIssue[]> => {
    const path = `${this.getPRBasePath("jira")}/issues`
    const res = await this.get(path)
    throwIfNotOk(res)
    return await res.json()
  }

  getDangerComments = async (dangerID: string): Promise<GitlabPRComment[]> => {
    const username = this.repoCredentials.username
    const activities = await this.getPullRequestComments()
    const dangerIDMessage = dangerIDToString(dangerID)

    const comments = activities.map(activity => activity.comment).filter(Boolean) as GitlabPRComment[]

    return comments
      .filter(comment => v.includes(comment!.text, dangerIDMessage))
      .filter(comment => username || comment!.author.name === username)
      .filter(comment => v.includes(comment!.text, dangerSignaturePostfix))
  }

  getDangerInlineComments = async (dangerID: string): Promise<Comment[]> => {
    const username = this.repoCredentials.username
    const activities = await this.getPullRequestComments()
    const dangerIDMessage = dangerIDToString(dangerID)

    const comments = activities
      .filter(activity => activity.commentAnchor)
      .map(activity => activity.comment)
      .filter(Boolean) as GitlabPRComment[]
    return new Promise<Comment[]>(resolve => {
      resolve(
        comments
          .map((i: any) => {
            return {
              id: i.id,
              ownedByDanger: i.author.name === username && i.text.includes(dangerIDMessage),
              body: i.text,
            }
          })
          .filter((i: any) => i.ownedByDanger)
      )
    })
  }

  // The last two are "optional" in the protocol, but not really optional WRT the BBSAPI
  getFileContents = async (filePath: string, repoSlug?: string, refspec?: string) => {
    const path = `${repoSlug}/` + `raw/${filePath}` + `?at=${refspec}`
    const res = await this.get(path, undefined, true)
    if (res.status === 404) {
      return ""
    }
    throwIfNotOk(res)
    return await res.text()
  }

  postBuildStatus = async (
    commitId: string,
    payload: {
      state: string
      key: string
      name: string
      url: string
      description: string
    }
  ) => {
    const res = await this.post(`rest/build-status/1.0/commits/${commitId}`, {}, payload)
    throwIfNotOk(res)
    // If the response status does not contain anything (error code === 204), do not return anything. Otherwise return the json response (seems like bitbucket server v4.10.1 returns 204 with empty response after setting the status)
    if (res.status !== 204) {
      return await res.json()
    }
  }

  postPRComment = async (comment: string) => {
    const path = `${this.getPRBasePath()}/comments`
    const res = await this.post(path, {}, { text: comment })
    return await res.json()
  }

  postInlinePRComment = async (comment: string, line: number, type: string, filePath: string) => {
    const path = `${this.getPRBasePath()}/comments`
    const t = { add: "ADDED", normal: "CONTEXT", del: "REMOVED" }[type]

    const res = await this.post(
      path,
      {},
      {
        text: comment,
        anchor: {
          line: line,
          lineType: t,
          fileType: "TO",
          path: filePath,
        },
      }
    )
    if (res.ok) {
      return res.json()
    } else {
      throw await res.json()
    }
  }

  deleteComment = async ({ id, version }: GitlabPRComment) => {
    const path = `${this.getPRBasePath()}/comments/${id}?version=${version}`
    const res = await this.delete(path)
    if (!res.ok) {
      throw new Error(`Failed to delete comment "${id}`)
    }
  }

  updateComment = async ({ id, version }: GitlabPRComment, comment: string) => {
    const path = `${this.getPRBasePath()}/comments/${id}`
    const res = await this.put(
      path,
      {},
      {
        text: comment,
        version,
      }
    )
    if (res.ok) {
      return res.json()
    } else {
      throw await res.json()
    }
  }

  // API implementation

  private api = (path: string, headers: any = {}, body: any = {}, method: string, suppressErrors?: boolean) => {
    if (this.repoCredentials.token) {
      headers["Authorization"] = `Bearer ${this.repoCredentials.token}`
    } else if (this.repoCredentials.password) {
      headers["Authorization"] = `Basic ${new Buffer(
        this.repoCredentials.username + ":" + this.repoCredentials.password
      ).toString("base64")}`
    }

    const url = `${this.repoCredentials.host}/${path}`
    this.d(`${method} ${url}`)

    // Allow using a proxy configured through environmental variables
    // Remember that to avoid the error "Error: self signed certificate in certificate chain"
    // you should also do: "export NODE_TLS_REJECT_UNAUTHORIZED=0". See: https://github.com/request/request/issues/2061
    let agent: Agent | undefined = undefined
    let proxy = process.env.http_proxy || process.env.https_proxy
    if (proxy) {
      agent = new HttpsProxyAgent(proxy)
    }

    return this.fetch(
      url,
      {
        method,
        body,
        headers: {
          "Content-Type": "application/json",
          ...headers,
        },
        agent,
      },
      suppressErrors
    )
  }

  get = (path: string, headers: any = {}, suppressErrors?: boolean): Promise<node_fetch.Response> =>
    this.api(path, headers, null, "GET", suppressErrors)

  post = (path: string, headers: any = {}, body: any = {}, suppressErrors?: boolean): Promise<node_fetch.Response> =>
    this.api(path, headers, JSON.stringify(body), "POST", suppressErrors)

  put = (path: string, headers: any = {}, body: any = {}): Promise<node_fetch.Response> =>
    this.api(path, headers, JSON.stringify(body), "PUT")

  delete = (path: string, headers: any = {}, body: any = {}): Promise<node_fetch.Response> =>
    this.api(path, headers, JSON.stringify(body), "DELETE")
}

function throwIfNotOk(res: node_fetch.Response) {
  if (!res.ok) {
    let message = `${res.status} - ${res.statusText}`
    if (res.status >= 400 && res.status < 500) {
      message += ` (Have you set DANGER_GITLAB_USERNAME and DANGER_GITLAB_PASSWORD or DANGER_GITLAB_TOKEN?)`
    }
    throw new Error(message)
  }
}
