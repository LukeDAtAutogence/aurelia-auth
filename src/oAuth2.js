import {inject} from 'aurelia-dependency-injection';
import {extend, forEach, isFunction, isString, joinUrl, camelCase, status, parseQueryString} from './auth-utilities';
import {Storage} from './storage';
import {Popup} from './popup';
import {BaseConfig} from './base-config';
import {Authentication} from './authentication';
import {HttpClient, json} from 'aurelia-fetch-client';

@inject(Storage, Popup, HttpClient, BaseConfig, Authentication)
export class OAuth2 {
  constructor(storage, popup, http, config, auth) {
    this.storage = storage;
    this.config = config.current;
    this.popup = popup;
    this.http = http;
    this.auth = auth;
    this.defaults = {
      url: null,
      name: null,
      state: null,
      scope: null,
      scopeDelimiter: null,
      redirectUri: null,
      popupOptions: null,
      authorizationEndpoint: null,
      responseParams: null,
      requiredUrlParams: null,
      optionalUrlParams: null,
      defaultUrlParams: ['response_type', 'client_id', 'redirect_uri'],
      responseType: 'code'
    };
  }

  endSession(options) {
    let current = extend({}, this.defaults, options);
    let url = current.endSessionUri;
    let postLogOurRedirectUri = current.postLogOurRedirectUri;
    let idToken = this.auth.getIdToken();
    window.location.assign(url + '?id_token_hint=' + idToken + '&post_logout_redirect_uri=' + postLogOurRedirectUri);
  }

  open(options, userData) {
    let current = extend({}, this.defaults, options);

    //state handling
    let stateName = current.name + '_state';

    if (isFunction(current.state)) {
      this.storage.set(stateName, current.state());
    } else if (isString(current.state)) {
      this.storage.set(stateName, current.state);
    }

    //nonce handling
    let nonceName = current.name + '_nonce';

    if (isFunction(current.nonce)) {
      this.storage.set(nonceName, current.nonce());
    } else if (isString(current.nonce)) {
      this.storage.set(nonceName, current.nonce);
    }

    let url = current.authorizationEndpoint + '?' + this.buildQueryString(current);

    if (current.display === 'page') {
      window.location.assign(url);
    } else {
      let openPopup;
      if (this.config.platform === 'mobile') {
        openPopup = this.popup.open(url, current.name, current.popupOptions, current.redirectUri).eventListener(current.redirectUri);
      } else {
        openPopup = this.popup.open(url, current.name, current.popupOptions, current.redirectUri).pollPopup();
      }

      return openPopup
        .then(oauthData => {
          if (oauthData.state && oauthData.state !== this.storage.get(stateName)) {
            return Promise.reject('OAuth 2.0 state parameter mismatch.');
          }

          if (current.responseType.toUpperCase().includes('TOKEN')) { //meaning implicit flow or hybrid flow
            if (!this.verifyIdToken(oauthData, current.name)) {
              return Promise.reject('OAuth 2.0 Nonce parameter mismatch.');
            }

            return oauthData;
          }

          return this.exchangeForToken(oauthData, userData, current); //responseType is authorization code only (no token nor id_token)
        });
    }
  }

  setTokenFromRedirect() {
    let queryParams = location.search.substring(1).replace(/\/$/, '');
    let hashParams = location.hash.substring(1).replace(/[\/$]/, '');
    let hash = parseQueryString(hashParams);
    let qs = parseQueryString(queryParams);
    extend(qs, hash);
    return qs;
  }


  verifyIdToken(oauthData, providerName) {
    let idToken = oauthData && oauthData[this.config.responseIdTokenProp];
    if (!idToken) return true;
    let idTokenObject = this.auth.decomposeToken(idToken);
    if (!idTokenObject) return true;
    let nonceFromToken = idTokenObject.nonce;
    if (!nonceFromToken) return true;
    let nonceInStorage = this.storage.get(providerName + '_nonce');
    if (nonceFromToken !== nonceInStorage) {
      return false;
    }
    return true;
  }

  exchangeForToken(oauthData, userData, current) {
    let data = extend({}, userData, {
      code: oauthData.code,
      clientId: current.clientId,
      redirectUri: current.redirectUri
    });

    if (oauthData.state) {
      data.state = oauthData.state;
    }

    forEach(current.responseParams, param => data[param] = oauthData[param]);

    let exchangeForTokenUrl = this.config.baseUrl ? joinUrl(this.config.baseUrl, current.url) : current.url;
    let credentials         = this.config.withCredentials ? 'include' : 'same-origin';

    return this.http.fetch(exchangeForTokenUrl, {
      method: 'post',
      body: json(data),
      credentials: credentials
    }).then(status);
  }

  buildQueryString(current) {
    let keyValuePairs = [];
    let urlParams     = ['defaultUrlParams', 'requiredUrlParams', 'optionalUrlParams'];

    forEach(urlParams, params => {
      forEach(current[params], paramName => {
        let camelizedName = camelCase(paramName);
        let paramValue    = isFunction(current[paramName]) ? current[paramName]() : current[camelizedName];

        if (paramName === 'state') {
          let stateName = current.name + '_state';
          paramValue    = encodeURIComponent(this.storage.get(stateName));
        }

        if (paramName === 'nonce') {
          let nonceName = current.name + '_nonce';
          paramValue    = encodeURIComponent(this.storage.get(nonceName));
        }

        if (paramName === 'scope' && Array.isArray(paramValue)) {
          paramValue = paramValue.join(current.scopeDelimiter);

          if (current.scopePrefix) {
            paramValue = [current.scopePrefix, paramValue].join(current.scopeDelimiter);
          }
        }

        keyValuePairs.push([paramName, paramValue]);
      });
    });

    return keyValuePairs.map(pair => pair.join('=')).join('&');
  }
}
