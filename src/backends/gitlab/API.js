import LocalForage from "localforage";
import { Base64 } from "js-base64";
import AssetProxy from "../../valueObjects/AssetProxy";
import { APIError } from "../../valueObjects/errors";

export default class API {
  constructor(config) {
    this.api_root = config.api_root || "https://gitlab.com/api/v3";
    this.token = config.token || false;
    this.branch = config.branch || "master";
    this.repo = config.repo || "";
    this.repoURL = `/projects/${ encodeURIComponent(this.repo) }/repository`;
  }

  user() {
    return this.request("/user");
  }

  requestHeaders(headers = {}) {
    const baseHeader = {
      "Content-Type": "application/json",
      ...headers,
    };

    if (this.token) {
      baseHeader.Authorization = `Bearer ${ this.token }`;
      return baseHeader;
    }

    return baseHeader;
  }

  parseJsonResponse(response) {
    return response.json().then((json) => {
      if (!response.ok) {
        return Promise.reject(json);
      }

      return json;
    });
  }

  urlFor(path, options) {
    const params = [];
    if (options.params) {
      Object.keys(options.params).map(key =>
        params.push(`${ key }=${ encodeURIComponent(options.params[key]) }`)
      );
    }
    if (params.length) {
      path += `?${ params.join("&") }`;
    }
    return this.api_root + path;
  }

  request(path, options = {}) {
    const headers = this.requestHeaders(options.headers || {});
    const url = this.urlFor(path, options);
    let responseStatus;
    return fetch(url, { ...options, headers }).then((response) => {
      responseStatus = response.status;
      const contentType = response.headers.get("Content-Type");
      if (contentType && contentType.match(/json/)) {
        return this.parseJsonResponse(response);
      }
      return response.text();
    })
    .catch((error) => {
      throw new APIError(error.message, responseStatus, 'GitLab');
    });
  }

  readFile(path, sha, branch = this.branch) {
    const cache = sha ? LocalForage.getItem(`gh.${ sha }`) : Promise.resolve(null);
    return cache.then((cached) => {
      if (cached) { return cached; }

      return this.request(`${ this.repoURL }/blobs/${ branch }`, {
        params: { filepath: path },
        cache: false,
      }).then((result) => {
        if (sha) {
          LocalForage.setItem(`gh.${ sha }`, result);
        }
        return result;
      });
    });
  }

  listFiles(path) {
    return this.request(`${ this.repoURL }/tree`, {
      params: { path, ref_name: this.branch },
    });
  }

  getFile(path) {
    return this.request(`${ this.repoURL }/files`, {
      params: { file_path: path, ref: this.branch },
    });
  }

  persistFiles(entry, mediaFiles, options) {
    const files = mediaFiles.concat(entry);

    const filePromises = files.map((file) => {
      const fileObj = {
        file_path: this.safeFilepath(file.path),
      };
      return Promise.resolve().then(() => {
        if (file instanceof AssetProxy) {
          return file.toBase64();
        }
        return this.toBase64(file.raw);
      }).then((content) => {
        fileObj.content = content;
        fileObj.encoding = "base64";
      })
      .then(() => this.getFile(file.path))
      .then(() => {
        fileObj.action = "update";
      }, (err) => {
        if (err.status === 404) {
          fileObj.action = "create";
        } else {
          throw err;
        }
      })
      .then(() => this.commit(options.commitMessage, [fileObj]));
    });

    return Promise.all(filePromises);
  }

  getBranch(branch = this.branch) {
    return this.request(`${ this.repoURL }/branches/${ encodeURIComponent(branch) }`);
  }

  createBranch(branchName, sha) {
    return this.request(`${ this.repoURL }/branches`, {
      method: "POST",
      body: JSON.stringify({ branch: branchName, ref: sha }),
    });
  }

  patchBranch(branchName, sha) {
    return this.createBranch(branchName, sha);
  }

  deleteBranch(branchName) {
    return this.request(`${ this.repoURL }/branches/${ encodeURIComponent(branchName) }`, {
      method: "DELETE",
    });
  }

  getTree(sha) {
    return sha ? this.request(`${ this.repoURL }/tree`, { params: { ref_name: sha } }) : Promise.resolve({ tree: [] });
  }

  toBase64(str) {
    return Promise.resolve(
      Base64.encode(str)
    );
  }

  safeFilepath(filepath) {
    // Gitlab only allows letters, digits, `_`, `-`, `@`, and `/` for directories in file paths.
    return filepath.replace(/[^a-z0-9_\-@./]/gi, '');
  }

  commit(commitMessage, actions) {
    const branchName = this.branch;
    return this.request(`${ this.repoURL }/commits`, {
      method: "POST",
      body: JSON.stringify({ branchName, commitMessage, actions }),
    });
  }

}
