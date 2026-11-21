use keyring::{Entry, Error as KeyringError};
use reqwest::{header, Client, StatusCode};
use serde::{de::DeserializeOwned, Deserialize, Serialize};
use serde_json::{json, Value};
use std::{sync::LazyLock, time::Duration};

static CLIENT: LazyLock<Result<Client, reqwest::Error>> = LazyLock::new(|| {
    Client::builder()
        .timeout(Duration::from_secs(20))
        .redirect(reqwest::redirect::Policy::none())
        .build()
});

fn keychain_entry() -> Result<Entry, String> {
    Entry::new("com.samue.spacron", "task-provider-linear")
        .map_err(|err| format!("Could not access the system keychain: {err}"))
}

fn saved_key() -> Result<Option<String>, String> {
    match keychain_entry()?.get_password() {
        Ok(key) => Ok(Some(key)),
        Err(KeyringError::NoEntry) => Ok(None),
        Err(err) => Err(format!("Could not read the Linear key: {err}")),
    }
}

fn required_key() -> Result<String, String> {
    saved_key()?.ok_or_else(|| "Connect Linear in Settings to browse issues.".to_string())
}

#[derive(Deserialize)]
struct GraphqlError {
    message: String,
}

#[derive(Deserialize)]
struct GraphqlResponse<T> {
    data: Option<T>,
    #[serde(default)]
    errors: Vec<GraphqlError>,
}

async fn graphql<T: DeserializeOwned>(
    key: &str,
    query: &str,
    variables: Value,
) -> Result<T, String> {
    let client = CLIENT
        .as_ref()
        .map_err(|_| "Could not initialize the Linear connection.".to_string())?;
    let mut authorization = header::HeaderValue::from_str(key)
        .map_err(|_| "Enter a valid Linear personal API key.".to_string())?;
    authorization.set_sensitive(true);
    let response = client
        .post("https://api.linear.app/graphql")
        .header(header::AUTHORIZATION, authorization)
        .json(&json!({ "query": query, "variables": variables }))
        .send()
        .await
        .map_err(|_| "Could not reach Linear. Check your connection and try again.".to_string())?;
    let status = response.status();
    match status {
        StatusCode::UNAUTHORIZED | StatusCode::FORBIDDEN => {
            return Err("Linear rejected the API key or its permissions.".into());
        }
        StatusCode::TOO_MANY_REQUESTS => {
            return Err("Linear's rate limit was reached. Try again shortly.".into());
        }
        _ => {}
    }
    // Decode errors before the requested data. GraphQL can return partial data
    // with null fields and errors, including on HTTP 200.
    let body: GraphqlResponse<Value> = response
        .json()
        .await
        .map_err(|_| format!("Linear returned an unreadable response (HTTP {status})."))?;
    if let Some(error) = body.errors.first() {
        return Err(format!("Linear: {}", error.message));
    }
    if !status.is_success() {
        return Err(format!("Linear returned HTTP {status}."));
    }
    serde_json::from_value(body.data.ok_or("Linear returned no data.")?)
        .map_err(|_| "Linear returned unexpected data.".into())
}

#[derive(Deserialize, Serialize)]
pub struct Identity {
    name: String,
}

#[derive(Deserialize)]
struct Viewer {
    viewer: Identity,
}

async fn identity(key: &str) -> Result<Identity, String> {
    let response: Viewer = graphql(key, "query { viewer { name } }", json!({})).await?;
    Ok(response.viewer)
}

#[tauri::command]
pub async fn linear_connect(api_key: String) -> Result<Identity, String> {
    let key = api_key.trim();
    if key.is_empty() {
        return Err("Enter a Linear personal API key.".into());
    }
    let viewer = identity(key).await?;
    keychain_entry()?
        .set_password(key)
        .map_err(|err| format!("Could not save the Linear key: {err}"))?;
    Ok(viewer)
}

#[tauri::command]
pub async fn linear_account() -> Result<Option<Identity>, String> {
    match saved_key()? {
        Some(key) => identity(&key).await.map(Some),
        None => Ok(None),
    }
}

#[tauri::command]
pub fn linear_disconnect() -> Result<(), String> {
    match keychain_entry()?.delete_credential() {
        Ok(()) | Err(KeyringError::NoEntry) => Ok(()),
        Err(err) => Err(format!("Could not remove the Linear key: {err}")),
    }
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct PageInfo {
    has_next_page: bool,
    end_cursor: Option<String>,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Connection<T> {
    nodes: Vec<T>,
    page_info: PageInfo,
}

#[derive(Deserialize, Serialize)]
pub struct Scope {
    id: String,
    name: String,
}

#[derive(Deserialize)]
struct Scopes {
    scopes: Connection<Scope>,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum ScopeKind {
    Team,
    Project,
}

#[tauri::command]
pub async fn linear_scopes(kind: ScopeKind) -> Result<Vec<Scope>, String> {
    let key = required_key()?;
    let collection = match kind {
        ScopeKind::Team => "teams",
        ScopeKind::Project => "projects",
    };
    let query = format!(
        "query($after: String) {{ scopes: {collection}(first: 50, after: $after) {{
            nodes {{ id name }}
            pageInfo {{ hasNextPage endCursor }}
        }} }}"
    );
    let mut scopes = Vec::new();
    let mut after: Option<String> = None;
    loop {
        let data: Scopes = graphql(&key, &query, json!({ "after": after })).await?;
        scopes.extend(data.scopes.nodes);
        if !data.scopes.page_info.has_next_page {
            return Ok(scopes);
        }
        let next = data.scopes.page_info.end_cursor;
        if next.is_none() || next == after {
            return Err("Linear returned an invalid pagination cursor.".into());
        }
        after = next;
    }
}

#[derive(Deserialize, Serialize)]
pub struct Named {
    name: String,
}

#[derive(Deserialize, Serialize)]
pub struct IssueSummary {
    id: String,
    identifier: String,
    title: String,
    state: Named,
    assignee: Option<Named>,
}

#[derive(Deserialize)]
struct Issues {
    issues: Connection<IssueSummary>,
}

#[tauri::command]
pub async fn linear_issues(
    kind: ScopeKind,
    scope_id: String,
    after: Option<String>,
) -> Result<Connection<IssueSummary>, String> {
    let key = required_key()?;
    let relation = match kind {
        ScopeKind::Team => "team",
        ScopeKind::Project => "project",
    };
    let query = format!(
        "query($scopeId: ID!, $after: String) {{
            issues(first: 50, after: $after, orderBy: updatedAt,
                filter: {{ {relation}: {{ id: {{ eq: $scopeId }} }} }}) {{
                nodes {{ id identifier title state {{ name }} assignee {{ name }} }}
                pageInfo {{ hasNextPage endCursor }}
            }}
        }}"
    );
    let data: Issues =
        graphql(&key, &query, json!({ "scopeId": scope_id, "after": after })).await?;
    Ok(data.issues)
}

#[derive(Deserialize, Serialize)]
pub struct IssueDetail {
    id: String,
    identifier: String,
    title: String,
    state: Named,
    assignee: Option<Named>,
    description: Option<String>,
    url: String,
}

#[derive(Deserialize)]
struct Issue {
    issue: Option<IssueDetail>,
}

#[tauri::command]
pub async fn linear_issue(id: String) -> Result<IssueDetail, String> {
    let key = required_key()?;
    let data: Issue = graphql(
        &key,
        "query($id: String!) { issue(id: $id) {
            id identifier title state { name } assignee { name } description url
        } }",
        json!({ "id": id }),
    )
    .await?;
    data.issue
        .ok_or_else(|| "Linear issue was not found.".into())
}
