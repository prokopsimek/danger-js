import { Env, CISource } from "../ci_source"
import { ensureEnvKeysExist } from "../ci_source_helpers"

interface MergeRequest {
  iid: string
}

export class GitlabActions implements CISource {
  constructor(private readonly env: Env) {}

  get name(): string {
    return "Gitlab"
  }

  get isCI(): boolean {
    return ensureEnvKeysExist(this.env, ["GITLAB_CI"])
  }

  get isPR(): boolean {
    const mustHave = ["GITLAB_CI", "CI_PROJECT_PATH"]
    return ensureEnvKeysExist(this.env, mustHave) && Number(this.pullRequestID) > 0
  }

  get pullRequestID(): string {
    // return env["CI_MERGE_REQUEST_ID"] if env["CI_MERGE_REQUEST_ID"]
    //   return 0 unless env["CI_COMMIT_SHA"]
    //   project_path = env["CI_PROJECT_PATH"]
    //   base_commit = env["CI_COMMIT_SHA"]
    //   client = RequestSources::GitLab.new(nil, env).client
    //   merge_requests = client.merge_requests(project_path, state: :opened)
    //   merge_request = merge_requests.auto_paginate.find do |mr|
    //     mr.sha == base_commit
    //   end
    //   merge_request.nil? ? 0 : merge_request.iid
    if (this.env.CI_MERGE_REQUEST_ID) {
      return this.env.CI_MERGE_REQUEST_ID
    } else if (!this.env.CI_COMMIT_SHA) {
      return "0"
    }

    // const projectPath: string = this.env.CI_PROJECT_PATH
    // const baseCommit: string = this.env.CI_COMMIT_SHA
    // const client: null = null
    // const mergeRequests: MergeRequest[] = []
    const mergeRequest: MergeRequest = { iid: "1" }

    return (mergeRequest === null ? "0" : mergeRequest.iid).toString()
  }

  get repoSlug(): string {
    return this.env.CI_PROJECT_PATH
  }

  get repoURL(): string {
    return this.env.CI_PROJECT_URL
  }
}
