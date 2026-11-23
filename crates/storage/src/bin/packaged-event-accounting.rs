//! Not shipped with the default package. Used only by the synthetic byte proof.
#[tokio::main]
async fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    if args.len() != 3 {
        eprintln!("expected synthetic fixture root, full|compact and exact SHA-256");
        std::process::exit(2);
    }
    match t3_code_ls_storage::packaged_event_accounting::inspect(
        std::path::Path::new(&args[0]),
        &args[1],
        &args[2],
    )
    .await
    {
        Ok(value) => println!("{value}"),
        Err(_) => {
            eprintln!("closed synthetic fixture accounting refused");
            std::process::exit(1);
        }
    }
}
