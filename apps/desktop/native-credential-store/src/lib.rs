use std::{cell::RefCell, ffi::CStr, os::raw::c_char, ptr, slice};

use keyring::v1::{Entry, Error as KeyringError};
use zeroize::Zeroizing;

const SERVICE: &str = "ai.deepseek.harness.desktop";
const MAX_CREDENTIAL_BYTES: usize = 64 * 1024;

thread_local! {
    static LAST_ERROR: RefCell<String> = const { RefCell::new(String::new()) };
}

fn validate_ref(reference: &str) -> Result<(), String> {
    let mut bytes = reference.bytes();
    let Some(first) = bytes.next() else {
        return Err("credential handle is empty".to_owned());
    };
    if !(first.is_ascii_alphabetic() || first == b'_')
        || !bytes.all(|byte| byte.is_ascii_alphanumeric() || byte == b'_')
    {
        return Err("credential handle must be a POSIX identifier".to_owned());
    }
    Ok(())
}

fn entry(reference: &str) -> Result<Entry, String> {
    validate_ref(reference)?;
    Entry::new(SERVICE, reference)
        .map_err(|error| format!("credential store is unavailable: {error}"))
}

pub fn get(reference: &str) -> Result<Option<Zeroizing<String>>, String> {
    match entry(reference)?.get_password() {
        Ok(value) if value.is_empty() => Ok(None),
        Ok(value) => Ok(Some(Zeroizing::new(value))),
        Err(KeyringError::NoEntry) => Ok(None),
        Err(error) => Err(format!("failed to read credential {reference}: {error}")),
    }
}

pub fn set(reference: &str, value: &str) -> Result<(), String> {
    if value.is_empty() {
        return Err("an empty credential cannot be stored".to_owned());
    }
    if value.len() > MAX_CREDENTIAL_BYTES {
        return Err(format!(
            "credential exceeds the {MAX_CREDENTIAL_BYTES}-byte desktop limit"
        ));
    }
    entry(reference)?
        .set_password(value)
        .map_err(|error| format!("failed to store credential {reference}: {error}"))
}

pub fn delete(reference: &str) -> Result<(), String> {
    match entry(reference)?.delete_credential() {
        Ok(()) | Err(KeyringError::NoEntry) => Ok(()),
        Err(error) => Err(format!("failed to delete credential {reference}: {error}")),
    }
}

fn remember_error(error: String) -> isize {
    LAST_ERROR.with(|slot| *slot.borrow_mut() = error);
    -2
}

unsafe fn reference_from_ptr<'a>(reference: *const c_char) -> Result<&'a str, String> {
    if reference.is_null() {
        return Err("credential handle pointer is null".to_owned());
    }
    CStr::from_ptr(reference)
        .to_str()
        .map_err(|_| "credential handle is not UTF-8".to_owned())
}

/// Copy one credential into a caller-owned buffer.
///
/// Returns the byte length, `-1` when absent, or `-2` on failure. The caller
/// obtains the failure text through `dsh_credential_last_error`.
#[no_mangle]
pub unsafe extern "C" fn dsh_credential_get(
    reference: *const c_char,
    output: *mut u8,
    capacity: usize,
) -> isize {
    let reference = match reference_from_ptr(reference) {
        Ok(reference) => reference,
        Err(error) => return remember_error(error),
    };
    let secret = match get(reference) {
        Ok(Some(secret)) => secret,
        Ok(None) => return -1,
        Err(error) => return remember_error(error),
    };
    if secret.len() > capacity || (secret.len() > 0 && output.is_null()) {
        return remember_error("credential output buffer is too small".to_owned());
    }
    if !secret.is_empty() {
        ptr::copy_nonoverlapping(secret.as_ptr(), output, secret.len());
    }
    secret.len() as isize
}

/// Report whether one credential handle is configured.
#[no_mangle]
pub unsafe extern "C" fn dsh_credential_status(reference: *const c_char) -> isize {
    let reference = match reference_from_ptr(reference) {
        Ok(reference) => reference,
        Err(error) => return remember_error(error),
    };
    match get(reference) {
        Ok(Some(_)) => 1,
        Ok(None) => 0,
        Err(error) => remember_error(error),
    }
}

/// Remove one credential by opaque handle without exposing its value.
#[no_mangle]
pub unsafe extern "C" fn dsh_credential_delete(reference: *const c_char) -> isize {
    let reference = match reference_from_ptr(reference) {
        Ok(reference) => reference,
        Err(error) => return remember_error(error),
    };
    match delete(reference) {
        Ok(()) => 0,
        Err(error) => remember_error(error),
    }
}

/// Copy the current thread's last failure into a caller-owned UTF-8 buffer.
#[no_mangle]
pub unsafe extern "C" fn dsh_credential_last_error(output: *mut u8, capacity: usize) -> isize {
    LAST_ERROR.with(|slot| {
        let error = slot.borrow();
        if error.len() > capacity || (error.len() > 0 && output.is_null()) {
            return -2;
        }
        if !error.is_empty() {
            slice::from_raw_parts_mut(output, error.len()).copy_from_slice(error.as_bytes());
        }
        error.len() as isize
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn credential_handles_are_posix_identifiers() {
        assert!(validate_ref("DEEPSEEK_API_KEY").is_ok());
        assert!(validate_ref("not-a-handle").is_err());
        assert!(validate_ref("").is_err());
    }
}
