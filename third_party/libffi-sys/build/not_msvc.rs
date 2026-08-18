use crate::common::*;
use std::{
    path::{Path, PathBuf},
    process::Command,
};

pub fn build_and_link() {
    let out_dir = env::var("OUT_DIR").unwrap();
    let build_dir = Path::new(&out_dir).join("libffi-build");
    let prefix = Path::new(&out_dir).join("libffi-root");
    let libdir = Path::new(&prefix).join("lib");
    let libdir32 = Path::new(&prefix).join("lib32");
    let libdir64 = Path::new(&prefix).join("lib64");

    // Copy LIBFFI_DIR into build_dir to avoid an unnecessary build
    if let Err(e) = fs::remove_dir_all(&build_dir) {
        assert_eq!(
            e.kind(),
            std::io::ErrorKind::NotFound,
            "can't remove the build directory: {e}",
        );
    }

    // On Linux, don't preserve the attributes of the source directory.
    // Not all cp versions support --no-preserve=mode,ownership, so we
    // first check if it's available.
    let mut command = Command::new("cp");
    let has_no_preserve_flag = {
        let output = Command::new("cp").arg("--help").output().unwrap().stdout;
        String::from_utf8(output).unwrap().contains("--no-preserve")
    };
    if has_no_preserve_flag {
        command.arg("--no-preserve=mode,ownership");
    }
    run_command(
        "Copying libffi into the build directory",
        command.arg("-R").arg("libffi").arg(&build_dir),
    );

    // Generate configure, run configure, make, make install
    configure_libffi(prefix, &build_dir);
    patch_android_libtool(&build_dir);

    let make_command = if cfg!(target_os = "aix") || cfg!(target_os = "illumos") {
        "gmake"
    } else {
        "make"
    };
    run_command(
        "Building libffi",
        Command::new(make_command)
            .env_remove("DESTDIR")
            .arg("install")
            .current_dir(build_dir),
    );

    // Cargo linking directives
    println!("cargo:rustc-link-lib=static=ffi");
    println!("cargo:rustc-link-search={}", libdir.display());
    println!("cargo:rustc-link-search={}", libdir32.display());
    println!("cargo:rustc-link-search={}", libdir64.display());
    link_android_compiler_rt();
}

pub fn probe_and_link() {
    println!("cargo:rustc-link-lib=dylib=ffi");
}

pub fn configure_libffi(prefix: PathBuf, build_dir: &Path) {
    let mut command = Command::new("sh");

    command
        .arg("./configure")
        .arg("--with-pic")
        .arg("--disable-shared")
        .arg("--disable-docs");

    let target = std::env::var("TARGET").unwrap();
    let host = std::env::var("HOST").unwrap();
    if target != host {
        let cross_host = match target.as_str() {
            // Autoconf uses riscv64 while Rust uses riscv64gc for the architecture
            "riscv64gc-unknown-linux-gnu" | "riscv64a23-unknown-linux-gnu" => {
                "riscv64-unknown-linux-gnu"
            }
            "riscv64gc-unknown-linux-musl" => "riscv64-unknown-linux-musl",
            // Autoconf does not yet recognize illumos, but Solaris should be fine
            "x86_64-unknown-illumos" => "x86_64-unknown-solaris",
            // configure.host does not extract `ios-sim` as OS.
            // The sources for `ios-sim` should be the same as `ios`.
            "aarch64-apple-ios-sim" => "aarch64-apple-ios",

            // MingW targets
            "x86_64-pc-windows-gnu" | "x86_64-pc-windows-gnullvm" => "x86_64-w64-mingw32",

            "i686-pc-windows-gnu" | "i686-pc-windows-gnullvm" => "i686-w64-mingw32",

            "aarch64-pc-windows-gnullvm" => "aarch64-w64-mingw32",
            // Everything else should be fine to pass straight through
            other => other,
        };
        command.arg(format!("--host={cross_host}"));
    }

    let mut c_cfg = cc::Build::new();
    c_cfg
        .cargo_metadata(false)
        .target(&target)
        .warnings(false)
        .host(&host);
    let c_compiler = c_cfg.get_compiler();

    // libtool is a Unix shell script: backslashes in CC are escape chars and
    // turn `C:\Users\...` into `C:Users...`. Forward slashes work on Windows.
    let cc_path = c_compiler.path().to_string_lossy().replace('\\', "/");
    command.env("CC", &cc_path);

    // NDK ships llvm-ar, not `$host-ar`. Without these, libtool sets AR=false
    // and `make` dies at `false cr libffi_convenience.a`.
    if let Some(ndk_bin) = c_compiler.path().parent() {
        let exe = if cfg!(windows) { ".exe" } else { "" };
        let tool = |name: &str| {
            ndk_bin
                .join(format!("{name}{exe}"))
                .to_string_lossy()
                .replace('\\', "/")
        };
        let ar = ndk_bin.join(format!("llvm-ar{exe}"));
        if ar.exists() {
            command.env("AR", tool("llvm-ar"));
            command.env("RANLIB", tool("llvm-ranlib"));
            command.env("NM", tool("llvm-nm"));
            command.env("STRIP", tool("llvm-strip"));
        }
    }

    let mut cflags = c_compiler.cflags_env();
    match env::var_os("CFLAGS") {
        None => (),
        Some(flags) => {
            cflags.push(" ");
            cflags.push(&flags);
        }
    }
    command.env("CFLAGS", cflags);

    for (k, v) in c_compiler.env() {
        command.env(k, v);
    }

    command.current_dir(build_dir);

    if cfg!(windows) {
        // When using MSYS2, OUT_DIR will be a Windows like path such as
        // C:\foo\bar. Unfortunately, the various scripts used for building
        // libffi do not like such a path, so we have to turn this into a Unix
        // like path such as /c/foo/bar.
        //
        // This code assumes the path only uses : for the drive letter, and only
        // uses \ as a component separator. It will likely break for file paths
        // that include a :.
        let mut msys_prefix = prefix
            .to_str()
            .unwrap()
            .replace(":\\", "/")
            .replace('\\', "/");

        msys_prefix.insert(0, '/');

        command.arg("--prefix").arg(msys_prefix);
    } else {
        command.arg("--prefix").arg(prefix);
    }

    if cfg!(target_os = "aix") || cfg!(target_os = "illumos") {
        command.env("MAKE", "gmake");
    }

    run_command("Configuring libffi", &mut command);
}

/// NDK clang rejects gcc's `-print-multi-os-directory`. libtool probes it
/// during compile; rewrite the probe to something clang accepts.
fn patch_android_libtool(build_dir: &Path) {
    fn walk(dir: &Path) {
        let Ok(entries) = fs::read_dir(dir) else {
            return;
        };
        for ent in entries.flatten() {
            let path = ent.path();
            if path.is_dir() {
                walk(&path);
                continue;
            }
            if path.file_name().and_then(|n| n.to_str()) != Some("libtool") {
                continue;
            }
            let Ok(c) = fs::read_to_string(&path) else {
                continue;
            };
            if !c.contains("-print-multi-os-directory") {
                continue;
            }
            let n = c.replace("-print-multi-os-directory", "-print-file-name=.");
            let _ = fs::write(&path, n);
        }
    }
    walk(build_dir);
}

/// Pull `__clear_cache` into the cdylib.
///
/// libffi's aarch64 `ffi_clear_cache` compiles to a call to `__clear_cache`.
/// NDK 29 clang does not bake compiler-rt into that .o, and the tablet's
/// bionic does not export the symbol, so `System.loadLibrary` dies at the
/// splash: `UnsatisfiedLinkError: cannot locate symbol "__clear_cache"`.
fn link_android_compiler_rt() {
    let target = match env::var("TARGET") {
        Ok(t) if t.contains("android") => t,
        _ => return,
    };
    let arch = if target.starts_with("aarch64") {
        "aarch64"
    } else if target.starts_with("armv7") || target.starts_with("arm-") {
        "arm"
    } else if target.starts_with("x86_64") {
        "x86_64"
    } else if target.starts_with("i686") {
        "i686"
    } else {
        return;
    };
    let host = env::var("HOST").unwrap_or_default();
    let mut c_cfg = cc::Build::new();
    c_cfg
        .cargo_metadata(false)
        .target(&target)
        .warnings(false)
        .host(&host);
    let compiler = c_cfg.get_compiler();
    let Some(prebuilt) = compiler.path().parent().and_then(|p| p.parent()) else {
        return;
    };
    let clang_lib = prebuilt.join("lib").join("clang");
    let Ok(vers) = fs::read_dir(&clang_lib) else {
        println!(
            "cargo:warning=libffi-sys: no {} — tablet may crash on __clear_cache",
            clang_lib.display()
        );
        return;
    };
    let libname = format!("libclang_rt.builtins-{arch}-android.a");
    for ver in vers.flatten() {
        let dir = ver.path().join("lib").join("linux");
        let archive = dir.join(&libname);
        if archive.is_file() {
            println!("cargo:rustc-link-search=native={}", dir.display());
            println!("cargo:rustc-link-lib=static=clang_rt.builtins-{arch}-android");
            return;
        }
    }
    println!("cargo:warning=libffi-sys: {libname} not under {}", clang_lib.display());
}
